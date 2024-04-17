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


DISPATCH_URL = "https://api.github.com/repos/navikt/tms-mikrofrontend-selector/dispatches"
RUN_URL = "https://api.github.com/repos/navikt/tms-mikrofrontend-selector/actions/runs"

DISPATCH_ID = random.randint(1000, 9999)

HEADERS = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "request"
}


def create_payload(args):
    return {
        "event_type": "update_microfrontend_manifest",
        "client_payload": {
            "id": args.id,
            "url": args.url,
            "cluster": args.cluster,
            "initiator": args.initiator,
            "commitmsg": args.message,
            "dispatch_id": DISPATCH_ID
        }
    }


def validate(args, parser):
    if args.cluster != "dev-gcp" and args.cluster != "prod-gcp":
        parser.error("Feil verdi for cluster, tillate verdier er dev-gcp eller prod-gcp")

    if "https://cdn.nav.no" not in args.url:
        parser.error("Feil verdi for manifesturl, må starte på https://cdn.nav.no")


def process_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("-id", required=True)
    parser.add_argument("-url", required=True)
    parser.add_argument("-cluster", required=True)
    parser.add_argument("-initiator", required=True)
    parser.add_argument("-message", required=True)
    parser.add_argument("-token", required=True)

    args = parser.parse_args()
    validate(args, parser)

    return args


def get_name(args, payload):
    try:
        print("Sender request til selector")
        response = requests.post(DISPATCH_URL, json=payload, headers=HEADERS, auth=BearerAuth(args.token))
        response.raise_for_status()
    except requests.exceptions.HTTPError as error:
        print(error)
        print(response.headers)
        sys.exit(1)

    print("Oppdatering av manifest startet")

    run_name = "Oppdater {0} i {1} : {2}  {3}".format(args.id, args.cluster, args.message, DISPATCH_ID)

    return run_name


def get_workflow_id(token, run_name):
    time.sleep(60)

    response = requests.get(RUN_URL, headers=HEADERS, auth=BearerAuth(token))
    response.raise_for_status()

    workflows = response.json()["workflow_runs"]

    workflow_id = [wf["id"]
                   for wf in workflows
                   if (wf['name'] == run_name)]

    return workflow_id[0]


def get_status(token, workflow_id):
    workflow_url = "{0}/{1}".format(RUN_URL, workflow_id)
    response = requests.get(workflow_url, headers=HEADERS, auth=BearerAuth(token))
    response.raise_for_status()

    return response.json()["conclusion"]


def check_status(token, run_name):
    try:
        workflow_id = get_workflow_id(token, run_name)
        status = get_status(token, workflow_id)

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


def main():
    args = process_args()
    payload = create_payload(args)
    name = get_name(args, payload)
    check_status(args.token, name)


if __name__ == "__main__":
    main()
