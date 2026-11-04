"""Labels distinguish spaces without guessing authorship or granting access."""

def test_labels_and_moves(client, topic, mx):
    project = mx['ws'] / 'projects' / 'acme'
    topic_dir = mx['ws'] / topic
    item = mx['files'] / 'file.txt'
    item.write_text('hello')
    def assign(path, label):
        return client.put('/api/space-labels', json={'path': str(path), 'label': label})
    assert client.get('/api/space-labels').json() == {}
    assert assign(project, 'personal').status_code == 200
    assert assign(topic_dir, 'agents').status_code == 200
    assert assign(item, 'shared').status_code == 200
    assert client.get('/api/space-labels').json()[str(topic_dir)] == 'agents'
    assert assign(mx['tmp'], 'personal').status_code == 403
    assert assign(item, 'nonsense').status_code == 422
    renamed = mx['files'] / 'renamed.txt'
    assert client.post('/api/files/move', json={'from': str(item), 'to': str(renamed)}).status_code == 200
    assert client.get('/api/space-labels').json()[str(renamed)] == 'shared'
    assert client.put('/api/files/write', json={'path': str(renamed), 'content': 'edited'}).status_code == 200
    assert client.get('/api/space-labels').json()[str(renamed)] == 'shared'
    assert client.patch('/api/workspace/projects/acme', json={'name':'renamed'}).status_code == 200
    labels = client.get('/api/space-labels').json()
    assert labels[str(mx['ws'] / 'projects' / 'renamed')] == 'personal'
    assert labels[str(mx['ws'] / 'projects' / 'renamed' / 'topics' / 'blog')] == 'agents'
    # Replacing an item at the same path cannot silently assign it the previous item's label.
    renamed.unlink()
    renamed.write_text('replacement')
    assert str(renamed) not in client.get('/api/space-labels').json()
