import mock
import unittest
import update_manifest
from unittest.mock import patch
import argparse


class TestGetWorkflowId(unittest.TestCase):
    def _mock_response(self, json=None):
        mock_response = mock.Mock()
        mock_response.json.return_value = json

        return mock_response

    @patch('time.sleep', return_value=None)
    @mock.patch('requests.get')
    def test_with_existing_id(self, mock_get):
        mock_resp = self._mock_response(json={
            "total_count": 1096,
            "workflow_runs": [
                {
                    "id": 8644156128,
                    "name": "Commit 123"
                },
                {
                    "id": 8644156129,
                    "name": "Commit 457"
                }
            ]
        })

        mock_get.return_value = mock_resp

        workflow_id = 8644156128
        run_name = "Commit 123"
        result = update_manifest.get_workflow_id(token="token", run_name=run_name)

        self.assertEqual(result, workflow_id)
        self.assertTrue(mock_resp.raise_for_status.called)


class TestGetStatus(unittest.TestCase):
    def _mock_response(self, json=None):
        mock_response = mock.Mock()
        mock_response.json.return_value = json

        return mock_response

    @mock.patch('requests.get')
    def test_with_existing_conclusion(self, mock_get):
        mock_resp = self._mock_response(json={
            "conclusion": "success"
        })

        mock_get.return_value = mock_resp
        result = update_manifest.get_status(token="token", workflow_id="123")

        self.assertEqual(result, "success")
        self.assertTrue(mock_resp.raise_for_status.called)


class TestValidate(unittest.TestCase):
    def test_with_cluster_and_url(self):
        parser = argparse.ArgumentParser()
        parser.add_argument("-url", default="https://cdn.nav.no/...")
        parser.add_argument("-cluster", default="dev-gcp")
        args = parser.parse_args()

        update_manifest.validate(args, parser)

    def test_without_cluster(self):
        parser = argparse.ArgumentParser()
        parser.add_argument("-url", default="https://cdn.nav.no/...")
        parser.add_argument("-cluster", default="")
        args = parser.parse_args()

        with self.assertRaises(SystemExit):
            update_manifest.validate(args, parser)

    def test_without_url(self):
        parser = argparse.ArgumentParser()
        parser.add_argument("-url", default="")
        parser.add_argument("-cluster", default="dev-gcp")
        args = parser.parse_args()

        with self.assertRaises(SystemExit):
            update_manifest.validate(args, parser)


if __name__ == '__main__':
    unittest.main()
