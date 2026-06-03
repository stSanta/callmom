<?php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

$ttlSeconds = 35;
$maxMessages = 220;
$storageDir = dirname(__FILE__) . DIRECTORY_SEPARATOR . '.callmom-signal';
$op = isset($_GET['op']) ? $_GET['op'] : '';

try {
    if ($op === 'sync') {
        syncMessages($storageDir, $ttlSeconds, $maxMessages);
    } elseif ($op === 'pull') {
        pullMessages($storageDir, $ttlSeconds, $maxMessages);
    } elseif ($op === 'push') {
        pushMessage($storageDir, $ttlSeconds, $maxMessages);
    } else {
        respond(array('ok' => false, 'error' => 'bad op'), 400);
    }
} catch (Exception $error) {
    respond(array('ok' => false, 'error' => 'server: ' . $error->getMessage()), 500);
}

function syncMessages($storageDir, $ttlSeconds, $maxMessages)
{
    $room = cleanRoom(isset($_GET['room']) ? (string)$_GET['room'] : '');

    if ($room === '') {
        respond(array('ok' => false, 'error' => 'bad room'), 400);
    }

    $data = pruneRoom(readRoom($storageDir, $room), $ttlSeconds, $maxMessages);

    respond(array(
        'ok' => true,
        'lastId' => (int)$data['lastId'],
        'messages' => array(),
        'now' => serverNowMs(),
    ));
}

function pullMessages($storageDir, $ttlSeconds, $maxMessages)
{
    $room = cleanRoom(isset($_GET['room']) ? (string)$_GET['room'] : '');
    $me = cleanPerson(isset($_GET['me']) ? (string)$_GET['me'] : '');
    $after = max(0, isset($_GET['after']) ? (int)$_GET['after'] : 0);

    if ($room === '' || $me === '') {
        respond(array('ok' => false, 'error' => 'bad room'), 400);
    }

    $data = pruneRoom(readRoom($storageDir, $room), $ttlSeconds, $maxMessages);

    $messages = array();
    foreach ($data['messages'] as $message) {
        $to = isset($message['to']) ? (string)$message['to'] : '';
        $id = isset($message['id']) ? (int)$message['id'] : 0;
        if ($id > $after && ($to === $me || $to === 'all')) {
            $messages[] = $message;
        }
    }

    respond(array(
        'ok' => true,
        'lastId' => (int)$data['lastId'],
        'messages' => $messages,
        'now' => serverNowMs(),
    ));
}

function pushMessage($storageDir, $ttlSeconds, $maxMessages)
{
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > 220000) {
        respond(array('ok' => false, 'error' => 'bad body'), 400);
    }

    $body = json_decode($raw, true);
    if (!is_array($body)) {
        respond(array('ok' => false, 'error' => 'bad json'), 400);
    }

    $room = cleanRoom(isset($body['room']) ? (string)$body['room'] : '');
    $from = cleanPerson(isset($body['from']) ? (string)$body['from'] : '');
    $to = cleanTo(isset($body['to']) ? (string)$body['to'] : '');
    $type = cleanType(isset($body['type']) ? (string)$body['type'] : '');
    $session = cleanSession(isset($body['session']) ? (string)$body['session'] : '');
    $payload = isset($body['payload']) ? $body['payload'] : array();

    if ($room === '' || $from === '' || $to === '' || $type === '') {
        respond(array('ok' => false, 'error' => 'bad message'), 400);
    }

    $data = withRoom($storageDir, $room, function ($data) use ($ttlSeconds, $maxMessages, $from, $to, $type, $session, $payload) {
        $data = pruneRoom($data, $ttlSeconds, $maxMessages);
        $id = (int)$data['lastId'] + 1;
        $data['lastId'] = $id;
        $data['messages'][] = array(
            'id' => $id,
            'createdAt' => serverNowMs(),
            'from' => $from,
            'to' => $to,
            'type' => $type,
            'session' => $session,
            'payload' => is_array($payload) ? $payload : array(),
        );
        $data = pruneRoom($data, $ttlSeconds, $maxMessages);
        $data['_lastPushId'] = $id;
        return $data;
    });

    respond(array(
        'ok' => true,
        'id' => isset($data['_lastPushId']) ? (int)$data['_lastPushId'] : (int)$data['lastId'],
        'lastId' => (int)$data['lastId'],
    ));
}

function withRoom($storageDir, $room, $callback)
{
    ensureStorage($storageDir);

    $file = $storageDir . DIRECTORY_SEPARATOR . $room . '.json';
    $handle = fopen($file, 'c+');
    if (!$handle) {
        throw new RuntimeException('cannot open room');
    }

    if (!flock($handle, LOCK_EX)) {
        fclose($handle);
        throw new RuntimeException('cannot lock room');
    }

    rewind($handle);
    $raw = stream_get_contents($handle);
    $data = parseRoomData($raw);

    $data = call_user_func($callback, $data);
    $persisted = $data;
    unset($persisted['_lastPushId']);

    rewind($handle);
    ftruncate($handle, 0);
    fwrite($handle, json_encode($persisted, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    fflush($handle);
    flock($handle, LOCK_UN);
    fclose($handle);

    return $data;
}

function readRoom($storageDir, $room)
{
    ensureStorage($storageDir);

    $file = $storageDir . DIRECTORY_SEPARATOR . $room . '.json';
    if (!is_file($file)) {
        return emptyRoom();
    }

    $handle = fopen($file, 'r');
    if (!$handle) {
        throw new RuntimeException('cannot read room');
    }

    if (!flock($handle, LOCK_SH)) {
        fclose($handle);
        throw new RuntimeException('cannot lock room for read');
    }

    $raw = stream_get_contents($handle);
    flock($handle, LOCK_UN);
    fclose($handle);

    return parseRoomData($raw);
}

function ensureStorage($storageDir)
{
    if (!is_dir($storageDir) && !mkdir($storageDir, 0775, true) && !is_dir($storageDir)) {
        throw new RuntimeException('cannot create storage');
    }
}

function parseRoomData($raw)
{
    $data = $raw ? json_decode($raw, true) : null;
    if (!is_array($data)) {
        return emptyRoom();
    }
    if (!isset($data['lastId']) || !isset($data['messages']) || !is_array($data['messages'])) {
        return emptyRoom();
    }

    return $data;
}

function emptyRoom()
{
    return array('lastId' => 0, 'messages' => array());
}

function pruneRoom($data, $ttlSeconds, $maxMessages)
{
    $now = serverNowMs();
    $messages = array();

    foreach ($data['messages'] as $message) {
        $createdAt = isset($message['createdAt']) ? (int)$message['createdAt'] : 0;
        $type = isset($message['type']) ? (string)$message['type'] : '';
        $messageTtl = $ttlSeconds;
        if ($type === 'audio') {
            $messageTtl = 5;
        } elseif ($type === 'hello') {
            $messageTtl = 20;
        }
        if ($createdAt >= $now - ($messageTtl * 1000)) {
            $messages[] = $message;
        }
    }

    if (count($messages) > $maxMessages) {
        $messages = array_slice($messages, -$maxMessages);
    }

    $data['messages'] = $messages;
    return $data;
}

function cleanRoom($value)
{
    return preg_match('/^[a-zA-Z0-9_-]{1,64}$/', $value) ? $value : '';
}

function cleanPerson($value)
{
    return ($value === '1' || $value === '2') ? $value : '';
}

function cleanTo($value)
{
    return ($value === '1' || $value === '2' || $value === 'all') ? $value : '';
}

function cleanType($value)
{
    return preg_match('/^[a-zA-Z0-9_-]{1,32}$/', $value) ? $value : '';
}

function cleanSession($value)
{
    return preg_match('/^[a-zA-Z0-9_-]{0,80}$/', $value) ? $value : '';
}

function serverNowMs()
{
    return (int)floor(microtime(true) * 1000);
}

function respond($data, $status = 200)
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}
