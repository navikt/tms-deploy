import sys

import requests
import argparse

# Ta imot commandlineargs

parser = argparse.ArgumentParser()

parser.add_argument("id")
parser.add_argument("url")
parser.add_argument("cluster")
parser.add_argument("initiator")
parser.add_argument("message")
parser.add_argument("token")

args = parser.parse_args()

action_url = "https://api.github.com/repos/navikt/tms-mikrofrontend-selector/dispatches"

# sette opp payload
payload = {
    "event_type": "update_microfrontend_manifest",
    "client_payload": {
        "id": args.id,
        "url": args.url,
        "cluster": args.cluster,
        "initiator": args.initiator,
        "commitmsg": args.message
    }}
headers = {
    "Accept": "application/vnd.github+json",
    "Authorization": f'Bearer {args.token}'

}
print(headers)

try:
    response = requests.post(action_url, json=payload, headers=headers)
    response.raise_for_status()
except requests.exceptions.HTTPError as error:
    print(error)
    sys.exit(1)

print("Oppdatering av manifest startet")
print(response.text)
print(response.content)