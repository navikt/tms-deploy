import sys
import argparse
import time

import requests.auth
import random


class BearerAuth(requests.auth.AuthBase):
    def __init__(self, token):
        self.token = token

    def __call__(self, r):
        r.headers["authorization"] = 'Bearer {}'.format(self.token)
        return r


parser = argparse.ArgumentParser()

parser.add_argument("id")
parser.add_argument("url")
parser.add_argument("cluster")
parser.add_argument("initiator")
parser.add_argument("message")
parser.add_argument("token")

args = parser.parse_args()

action_url = "https://api.github.com/repos/navikt/tms-mikrofrontend-selector/dispatches"
dispatch_id = random.randint(1000, 9999)

payload = {
    "event_type": "update_microfrontend_manifest",
    "client_payload": {
        "id": args.id,
        "url": args.url,
        "cluster": args.cluster,
        "initiator": args.initiator,
        "commitmsg": args.message,
        "dispatch_id": dispatch_id
    }
}

headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "request"
}

try:
    response = requests.post(action_url, json=payload, headers=headers, auth=BearerAuth(args.token))
    response.raise_for_status()
except requests.exceptions.HTTPError as error:
    print(error)
    print(response.headers)
    sys.exit(1)

print("Oppdatering av manifest startet")

run_name = "Oppdater {0} i {1} : {2}  {3}".format(
    args.id, args.cluster, args.commitmsg, dispatch_id
)

try:
    time.sleep(60)
    response = requests.get("https://api.github.com/repos/navikt/tms-mikrofrontend-selector/actions/runs",
                            headers=headers, auth=BearerAuth(args.token))
    response.raise_for_status()
    run_name = "Oppdater tms-shell i dev-gcp : dev-gcp"
    workflows = response.json()["workflow_runs"]
    workflow_id = filter(lambda x: x["name"] == run_name, workflows).__next__()["id"]

    response = requests.get(
        "https://api.github.com/repos/navikt/tms-mikrofrontend-selector/actions/runs/{}".format(workflow_id),
        headers=headers, auth=BearerAuth(args.token))
    response.raise_for_status()
    status = response.json()["conclusion"]
    if status == "success":
        print("Manifesteturl er oppdatert! ")
        sys.exit(0)
    elif status == "failure":
        print("Manifestoppdatering feiler i tms-mikrofrontend-selector, kontakt team min side")
        sys.exit(1)
    else:
        print("Oppdatering er kjørt med ukjent resultat")

except requests.exceptions.HTTPError as error:
    print("Fant ikke status for workflow i tms-mikrofrontend-selector.{}".format(error))
    sys.exit(0)
except Exception as error:
    print("Feil i henting av status: {}".format(error))
    sys.exit(0)
