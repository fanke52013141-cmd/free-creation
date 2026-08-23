import tempfile
import unittest
from pathlib import Path

from app.database import Database


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temp.name) / 'test.db')
        self.db.initialize()

    def tearDown(self):
        self.temp.cleanup()

    def test_snapshot_round_trip(self):
        shapes = [{'id': 'shape:1', 'type': 'text-asset', 'props': {'text': 'hello'}}]
        self.db.put_snapshot('project_1', shapes)
        self.assertEqual(self.db.get_snapshot('project_1'), shapes)

    def test_recover_tasks_requeues_interrupted_work(self):
        self.db.create_task('task_1', 'video', 'model_1', {'prompts': ['hello']})
        self.db.update_task('task_1', status='running', progress=42)
        self.assertEqual(self.db.recover_tasks(), ['task_1'])
        task = self.db.get_task('task_1')
        self.assertEqual(task['status'], 'pending')
        self.assertEqual(task['progress'], 0)

    def test_canceled_tasks_are_not_recovered(self):
        self.db.create_task('task_2', 'image', 'model_1', {'prompts': ['hello']})
        self.db.update_task('task_2', status='canceled')
        self.assertEqual(self.db.recover_tasks(), [])


if __name__ == '__main__':
    unittest.main()
