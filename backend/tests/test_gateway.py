import unittest

from app.gateway import image_urls, upstream_status, upstream_task_id


class GatewayParsingTests(unittest.TestCase):
    def test_image_url_and_base64_results(self):
        payload = {'data': [{'url': 'https://example.test/a.png'}, {'b64_json': 'YWJj'}]}
        self.assertEqual(image_urls(payload), ['https://example.test/a.png', 'data:image/png;base64,YWJj'])

    def test_nested_task_identity_and_status(self):
        payload = {'data': {'task_id': 'job_1', 'status': 'RUNNING'}}
        self.assertEqual(upstream_task_id(payload), 'job_1')
        self.assertEqual(upstream_status(payload), 'running')


if __name__ == '__main__':
    unittest.main()
