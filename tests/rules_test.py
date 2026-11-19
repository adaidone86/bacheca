"""Prove delle regole Firebase su TEST via REST (Auth + Realtime Database).
Crea 2 utenti di prova, prova ogni regola (permesso/bloccato), poi cancella dati e utenti."""
import json, re, secrets, sys, time, urllib.request, urllib.error
sys.stdout.reconfigure(encoding="utf-8")

cfg = open(sys.argv[1], encoding='utf-8').read()
test_block = cfg[cfg.index('TEST: {'):cfg.index('PROD: {')]
API_KEY = re.search(r'apiKey:\s*"([^"]+)"', test_block).group(1)
DB = re.search(r'databaseURL:\s*"([^"]+)"', test_block).group(1)
assert 'bacheca-test' in DB, 'Non è il database di TEST!'

def http(method, url, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or 'null')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or 'null')
        except Exception:
            return e.code, None

def signup(tag):
    email = f'claudetest{tag}{secrets.token_hex(3)}@bacheca.local'
    pwd = secrets.token_urlsafe(12)
    st, r = http('POST', f'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={API_KEY}',
                 {'email': email, 'password': pwd, 'returnSecureToken': True})
    assert st == 200, f'Registrazione fallita: {st} {r}'
    return {'uid': r['localId'], 'token': r['idToken'], 'username': email.split('@')[0]}

def db(user, method, path, body=None):
    url = f'{DB}/{path}.json?auth={user["token"]}'
    return http(method, url, body)

results = []
def check(name, expected, user, method, path, body=None):
    st, _ = db(user, method, path, body)
    ok = st == 200
    good = (expected == 'permesso') == ok
    results.append((('✅' if good else '❌ PROBLEMA'), name, expected, 'permesso' if ok else f'bloccato ({st})'))
    return ok

A = signup('a'); B = signup('b')
now = int(time.time() * 1000)
try:
    # Profili
    check('A crea il proprio profilo', 'permesso', A, 'PUT', f'users/{A["uid"]}', {'username': A['username'][:20], 'name': 'ProvaA', 'createdAt': now})
    check('B crea il proprio profilo', 'permesso', B, 'PUT', f'users/{B["uid"]}', {'username': B['username'][:20], 'name': 'ProvaB', 'createdAt': now})
    check('Nome di 11 caratteri', 'bloccato', B, 'PUT', f'users/{B["uid"]}/name', 'X' * 11)
    check('Nome di 10 caratteri', 'permesso', B, 'PUT', f'users/{B["uid"]}/name', 'X' * 10)
    check('B cambia il nome di A', 'bloccato', B, 'PUT', f'users/{A["uid"]}/name', 'hacker')

    # Eventi
    eid = f'claudetest_{now}'
    ev = {'id': eid, 'date': '2099-12-31', 'title': 'Prova regole', 'time': '20:30', 'location': 'Qui', 'notes': 'n',
          'fee': 10, 'color': 'color-teal', 'link': 'https://example.com', 'creatorId': A['uid'], 'createdAt': now}
    check('A crea un evento', 'permesso', A, 'PUT', f'events/{eid}', ev)
    eid2 = eid + 'x'
    check('A crea un evento a nome di B', 'bloccato', A, 'PUT', f'events/{eid2}', {**ev, 'id': eid2, 'creatorId': B['uid']})
    check('Titolo di 100 caratteri', 'permesso', A, 'PUT', f'events/{eid}/title', 'T' * 100)
    check('Titolo di 101 caratteri', 'bloccato', A, 'PUT', f'events/{eid}/title', 'T' * 101)
    check('Note di 500 caratteri', 'permesso', A, 'PUT', f'events/{eid}/notes', 'N' * 500)
    check('Note di 501 caratteri', 'bloccato', A, 'PUT', f'events/{eid}/notes', 'N' * 501)
    check('Link di 501 caratteri', 'bloccato', A, 'PUT', f'events/{eid}/link', 'https://' + 'l' * 493)
    check('Ora di 31 caratteri', 'bloccato', A, 'PUT', f'events/{eid}/time', 'h' * 31)
    check('Luogo di 201 caratteri', 'bloccato', A, 'PUT', f'events/{eid}/location', 'L' * 201)
    check('Quota 999', 'permesso', A, 'PUT', f'events/{eid}/fee', 999)
    check('Quota 1000', 'bloccato', A, 'PUT', f'events/{eid}/fee', 1000)
    check('Quota negativa', 'bloccato', A, 'PUT', f'events/{eid}/fee', -1)
    check('Categoria non valida', 'bloccato', A, 'PUT', f'events/{eid}/color', 'rosso"><script>')
    check('Campo sconosciuto', 'bloccato', A, 'PUT', f'events/{eid}/hack', 'x')
    check('Data in formato sbagliato', 'bloccato', A, 'PUT', f'events/{eid}/date', '31/12/2099')
    check('A cambia il creatore', 'bloccato', A, 'PUT', f'events/{eid}/creatorId', B['uid'])
    check('B modifica il titolo di A', 'bloccato', B, 'PUT', f'events/{eid}/title', 'hack')
    check('B elimina l\'evento di A', 'bloccato', B, 'DELETE', f'events/{eid}')

    # Immagini
    img_ok = 'data:image/jpeg;base64,' + 'A' * (99000 - 23)
    img_big = 'data:image/jpeg;base64,' + 'A' * (100001 - 23)
    check('A: immagine da 99.000 caratteri', 'permesso', A, 'PUT', f'eventImages/{eid}', img_ok)
    check('A: immagine da 100.001 caratteri', 'bloccato', A, 'PUT', f'eventImages/{eid}', img_big)
    check('A: immagine che non è un\'immagine', 'bloccato', A, 'PUT', f'eventImages/{eid}', 'ciao')
    check('B cambia l\'immagine di A', 'bloccato', B, 'PUT', f'eventImages/{eid}', img_ok)

    # Partecipanti e chat
    msg = lambda u, text: {'deviceId': u['uid'], 'name': 'Prova', 'text': text, 'timestamp': now}
    check('B scrive in chat senza essere iscritto', 'bloccato', B, 'POST', f'eventChats/{eid}/messages', msg(B, 'ciao'))
    check('B iscrive A', 'bloccato', B, 'PUT', f'events/{eid}/participants/{A["uid"]}', True)
    check('B si iscrive', 'permesso', B, 'PUT', f'events/{eid}/participants/{B["uid"]}', True)
    check('B: messaggio da 300 caratteri', 'permesso', B, 'PUT', f'eventChats/{eid}/messages/m1', msg(B, 'M' * 300))
    check('B: messaggio da 301 caratteri', 'bloccato', B, 'PUT', f'eventChats/{eid}/messages/m2', msg(B, 'M' * 301))
    check('B scrive a nome di A', 'bloccato', B, 'PUT', f'eventChats/{eid}/messages/m3', msg(A, 'finto'))
    check('B modifica il proprio messaggio', 'bloccato', B, 'PUT', f'eventChats/{eid}/messages/m1/text', 'modificato')
    check('B cancella il proprio messaggio', 'bloccato', B, 'DELETE', f'eventChats/{eid}/messages/m1')
    check('A (creatore) cancella solo la chat', 'bloccato', A, 'DELETE', f'eventChats/{eid}')
    check('B cancella la chat', 'bloccato', B, 'DELETE', f'eventChats/{eid}')

    # Letture chat e presenza
    check('B salva la propria lettura', 'permesso', B, 'PUT', f'chatReadStatus/{B["uid"]}/{eid}', {'lastReadTimestamp': now})
    check('B legge le letture di A', 'bloccato', B, 'GET', f'chatReadStatus/{A["uid"]}')
    check('B salva la lettura di A', 'bloccato', B, 'PUT', f'chatReadStatus/{A["uid"]}/{eid}', {'lastReadTimestamp': now})
    check('B segna la propria presenza', 'permesso', B, 'PUT', f'presence/{B["uid"]}/c1', {'active': True, 'at': now})
    check('Presenza con active non booleano', 'bloccato', B, 'PUT', f'presence/{B["uid"]}/c2', {'active': 'si'})
    check('B segna la presenza di A', 'bloccato', B, 'PUT', f'presence/{A["uid"]}/c1', {'active': True})

    # Proposte
    pid = f'claudetestp_{now}'
    pr = {'id': pid, 'title': 'Proposta di prova', 'location': '', 'notes': '', 'fee': 0, 'link': '', 'color': 'color-neutral',
          'creatorId': A['uid'], 'creatorName': 'ProvaA', 'createdAt': now}
    check('A crea una proposta', 'permesso', A, 'PUT', f'proposals/{pid}', pr)
    check('Proposta con creatorName di 11 caratteri', 'bloccato', A, 'PUT', f'proposals/{pid}/creatorName', 'X' * 11)
    check('Proposta con titolo di 101 caratteri', 'bloccato', A, 'PUT', f'proposals/{pid}/title', 'T' * 101)
    check('Proposta con campo sconosciuto', 'bloccato', A, 'PUT', f'proposals/{pid}/hack', 'x')
    check('A cambia il creatore della proposta', 'bloccato', A, 'PUT', f'proposals/{pid}/creatorId', B['uid'])
    check('B modifica la proposta di A', 'bloccato', B, 'PUT', f'proposals/{pid}/title', 'hack')
    opt = lambda u: {'addedBy': 'Prova', 'addedById': u['uid'], 'createdAt': now}
    check('B propone una data', 'permesso', B, 'PUT', f'proposals/{pid}/dateOptions/2099-01-02_2030', opt(B))
    check('B propone una data a nome di A', 'bloccato', B, 'PUT', f'proposals/{pid}/dateOptions/2099-01-03', opt(A))
    check('B: data con chiave non valida', 'bloccato', B, 'PUT', f'proposals/{pid}/dateOptions/domani', opt(B))
    check('A propone una data', 'permesso', A, 'PUT', f'proposals/{pid}/dateOptions/2099-01-04', opt(A))
    check('B cancella la data di A', 'bloccato', B, 'DELETE', f'proposals/{pid}/dateOptions/2099-01-04')
    check('B cancella la propria data', 'permesso', B, 'DELETE', f'proposals/{pid}/dateOptions/2099-01-02_2030')
    check('B propone di nuovo una data', 'permesso', B, 'PUT', f'proposals/{pid}/dateOptions/2099-01-05', opt(B))
    check('A (creatore) cancella la data di B', 'permesso', A, 'DELETE', f'proposals/{pid}/dateOptions/2099-01-05')
    check('B vota', 'permesso', B, 'PUT', f'proposals/{pid}/votes/2099-01-04/{B["uid"]}', {'name': 'ProvaB', 'deviceId': B['uid']})
    check('B vota a nome di A', 'bloccato', B, 'PUT', f'proposals/{pid}/votes/2099-01-04/{A["uid"]}', {'name': 'ProvaA', 'deviceId': A['uid']})
    check('B fissa la proposta di A', 'bloccato', B, 'PUT', f'proposals/{pid}/fixedDate', '2099-01-04')
    check('B scrive nella chat della proposta', 'permesso', B, 'PUT', f'eventChats/{pid}/messages/p1', msg(B, 'per me va bene'))
    check('A cancella solo la chat della proposta', 'bloccato', A, 'DELETE', f'eventChats/{pid}')
    check('B elimina la proposta di A', 'bloccato', B, 'DELETE', f'proposals/{pid}')

    # Eliminazioni corrette (come fa l'app: tutto in un'unica scrittura)
    check('A elimina la proposta con chat e immagine insieme', 'permesso', A, 'PATCH', '',
          {f'proposals/{pid}': None, f'eventChats/{pid}': None, f'eventImages/{pid}': None})
    check('A elimina l\'evento con chat e immagine insieme', 'permesso', A, 'PATCH', '',
          {f'events/{eid}': None, f'eventChats/{eid}': None, f'eventImages/{eid}': None})
finally:
    # Pulizia: dati degli utenti di prova e account
    for u in (A, B):
        http('DELETE', f'{DB}/presence/{u["uid"]}.json?auth={u["token"]}')
        http('DELETE', f'{DB}/chatReadStatus/{u["uid"]}.json?auth={u["token"]}')
        http('DELETE', f'{DB}/users/{u["uid"]}.json?auth={u["token"]}')
    left = []
    for path in [f'events/{eid}', f'proposals/{pid}', f'eventChats/{eid}', f'eventChats/{pid}', f'eventImages/{eid}']:
        st, val = db(A, 'GET', path)
        if val is not None: left.append(path)
    for u in (A, B):
        http('POST', f'https://identitytoolkit.googleapis.com/v1/accounts:delete?key={API_KEY}', {'idToken': u['token']})

w = max(len(r[1]) for r in results)
for r in results:
    print(f'{r[0]:<12} {r[1]:<{w}}  atteso: {r[2]:<9} esito: {r[3]}')
bad = [r for r in results if r[0] != '✅']
print(f'\n{len(results)} prove, {len(results) - len(bad)} ok, {len(bad)} problemi')
print('Dati di prova rimasti:', left or 'nessuno')
