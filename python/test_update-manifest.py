import mock
import unittest
import update_manifest
from unittest.mock import patch


class TestGetWorkflowId(unittest.TestCase):
    def _mock_response(self, status=200, content="Content", json_data=None, raise_for_status=None):

        mock_response = mock.Mock()
        mock_response.raise_for_status = mock.Mock()

        if raise_for_status:
            mock_response.raise_for_status.side_effect = raise_for_status

        mock_response.status_code = status
        mock_response.content = content

        if json_data:
            mock_response.json = mock.Mock(return_value=json_data)

        return mock_response

    @patch('time.sleep', return_value=None)
    @mock.patch('requests.get')
    def test_with_existing_id(self, mock_get):
        mock_resp = self._mock_response(json_data={
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
    def _mock_response(self, status=200, content="Content", json_data=None, raise_for_status=None):

        mock_response = mock.Mock()
        mock_response.raise_for_status = mock.Mock()

        if raise_for_status:
            mock_response.raise_for_status.side_effect = raise_for_status

        mock_response.status_code = status
        mock_response.content = content

        if json_data:
            mock_response.json = mock.Mock(return_value=json_data)

        return mock_response

    @mock.patch('requests.get')
    def test_with_existing_conclusion(self, mock_get):
        mock_resp = self._mock_response(json_data={"conclusion": "success"})

        mock_get.return_value = mock_resp

        result = update_manifest.get_status(token="token", workflow_id="123")

        self.assertEqual(result, "success")
        self.assertTrue(mock_resp.raise_for_status.called)


if __name__ == '__main__':
    unittest.main()