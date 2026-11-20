"""Prove delle regole Firebase su TEST via REST (Auth + Realtime Database).
Crea 2 utenti di prova, prova ogni regola (permesso/bloccato), poi cancella dati e utenti.
Prove dell'amministratore (0.5.0): servono le credenziali di un account che su TEST ha roles/{uid} = "admin",
passate con le variabili d'ambiente BACHECA_ADMIN_USER e BACHECA_ADMIN_PASS (senza, quelle prove si saltano)."""
import json, os, re, secrets, sys, time, urllib.request, urllib.error
sys.stdout.reconfigure(encoding="utf-8")

cfg = open(sys.argv[1], encoding='utf-8').read()
test_block = cfg[cfg.index('TEST: {'):cfg.index('PROD: {')]
API_KEY = re.search(r'apiKey:\s*"([^"]+)"', test_block).group(1)
DB = re.search(r'databaseURL:\s*"([^"]+)"', test_block).group(1)
assert 'bacheca-test' in DB, 'Non è il database di TEST!'

def http(method, url, body=None, tries=3):
    # Se la connessione cade (capita con Google), riprova fino a 3 volte
    for attempt in range(tries):
        try:
            return _http(method, url, body)
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
            if isinstance(e, urllib.error.HTTPError) or attempt == tries - 1:
                raise
            time.sleep(1 + attempt)

def _http(method, url, body=None):
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

def signin(username, password):
    email = username if '@' in username else f'{username}@bacheca.local'
    st, r = http('POST', f'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={API_KEY}',
                 {'email': email, 'password': password, 'returnSecureToken': True})
    assert st == 200, f'Login amministratore fallito: {st}'
    return {'uid': r['localId'], 'token': r['idToken'], 'username': username}

if not (os.environ.get('BACHECA_ADMIN_USER') and os.environ.get('BACHECA_ADMIN_PASS')):
    # Dalla 0.6.0 i nuovi iscritti devono essere approvati: senza un amministratore gli utenti di prova non vedono niente
    sys.exit('Servono BACHECA_ADMIN_USER e BACHECA_ADMIN_PASS (account TEST con ruolo admin): '
             'gli utenti di prova vanno approvati per poter fare le prove.')
ADM = signin(os.environ['BACHECA_ADMIN_USER'], os.environ['BACHECA_ADMIN_PASS'])
A = signup('a'); B = signup('b')
now = int(time.time() * 1000)
try:
    # Profili (anche chi è in attesa di approvazione crea e legge il proprio)
    check('A crea il proprio profilo', 'permesso', A, 'PUT', f'users/{A["uid"]}', {'username': A['username'][:20], 'name': 'ProvaA', 'createdAt': now})
    check('B crea il proprio profilo', 'permesso', B, 'PUT', f'users/{B["uid"]}', {'username': B['username'][:20], 'name': 'ProvaB', 'createdAt': now})

    # Approvazione (0.6.0): chi è in attesa non vede niente finché un admin non lo approva
    check('In attesa: A legge il proprio profilo', 'permesso', A, 'GET', f'users/{A["uid"]}')
    check('In attesa: A legge la propria approvazione', 'permesso', A, 'GET', f'approved/{A["uid"]}')
    check('In attesa: A legge gli eventi', 'bloccato', A, 'GET', 'events')
    check('In attesa: A legge gli utenti', 'bloccato', A, 'GET', 'users')
    check('In attesa: A legge le chat', 'bloccato', A, 'GET', 'eventChats')
    check('In attesa: A legge chi è collegato', 'bloccato', A, 'GET', 'presence')
    check('In attesa: A segna la propria presenza', 'bloccato', A, 'PUT', f'presence/{A["uid"]}/c1', {'active': True, 'at': now})
    check('In attesa: A si approva da solo', 'bloccato', A, 'PUT', f'approved/{A["uid"]}', True)
    check('In attesa: A legge tutte le approvazioni', 'bloccato', A, 'GET', 'approved')
    check('Admin approva A e B', 'permesso', ADM, 'PATCH', '', {f'approved/{A["uid"]}': True, f'approved/{B["uid"]}': True})
    check('Approvazione con valore diverso da true', 'bloccato', ADM, 'PUT', f'approved/{A["uid"]}', 'si')
    check('Admin legge tutte le approvazioni', 'permesso', ADM, 'GET', 'approved')
    check('Approvato: A legge gli eventi', 'permesso', A, 'GET', 'events')
    check('B toglie l\'approvazione ad A', 'bloccato', B, 'DELETE', f'approved/{A["uid"]}')
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
    check('Presenza fantasma (senza at)', 'bloccato', B, 'PUT', f'presence/{B["uid"]}/c3', {'active': True})
    check('B cambia active della propria presenza', 'permesso', B, 'PATCH', f'presence/{B["uid"]}/c1', {'active': False})

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
    check('B cancella la propria data', 'bloccato', B, 'DELETE', f'proposals/{pid}/dateOptions/2099-01-02_2030')
    check('B modifica la propria data', 'bloccato', B, 'PUT', f'proposals/{pid}/dateOptions/2099-01-02_2030', {**opt(B), 'addedBy': 'altro'})
    check('A (creatore) cancella la data di B', 'bloccato', A, 'DELETE', f'proposals/{pid}/dateOptions/2099-01-02_2030')
    check('A (creatore) cancella la propria data', 'bloccato', A, 'DELETE', f'proposals/{pid}/dateOptions/2099-01-04')
    check('A cancella le date con una scrittura sulla proposta', 'bloccato', A, 'PATCH', f'proposals/{pid}', {'dateOptions': None})
    check('A (creatore) modifica il titolo', 'permesso', A, 'PUT', f'proposals/{pid}/title', 'Proposta modificata')
    check('A (creatore) modifica più campi insieme', 'permesso', A, 'PATCH', f'proposals/{pid}', {'notes': 'note', 'fee': 5, 'color': 'color-blue'})
    check('B vota', 'permesso', B, 'PUT', f'proposals/{pid}/votes/2099-01-04/{B["uid"]}', {'name': 'ProvaB', 'deviceId': B['uid']})
    check('B vota a nome di A', 'bloccato', B, 'PUT', f'proposals/{pid}/votes/2099-01-04/{A["uid"]}', {'name': 'ProvaA', 'deviceId': A['uid']})
    check('B fissa la proposta di A', 'bloccato', B, 'PUT', f'proposals/{pid}/fixedDate', '2099-01-04')
    check('B scrive nella chat della proposta', 'permesso', B, 'PUT', f'eventChats/{pid}/messages/p1', msg(B, 'per me va bene'))
    check('A cancella solo la chat della proposta', 'bloccato', A, 'DELETE', f'eventChats/{pid}')
    check('B elimina la proposta di A', 'bloccato', B, 'DELETE', f'proposals/{pid}')

    # "Fissa questa data" come fa l'app: blocco fixedDate, evento con lo stesso id e i votanti, poi via la proposta
    fid = f'claudetestf_{now}'
    check('A crea una seconda proposta', 'permesso', A, 'PUT', f'proposals/{fid}', {**pr, 'id': fid,
          'dateOptions': {'2099-02-01_2100': opt(A)}})
    check('B vota la data da fissare', 'permesso', B, 'PUT', f'proposals/{fid}/votes/2099-02-01_2100/{B["uid"]}', {'name': 'ProvaB', 'deviceId': B['uid']})
    check('A fissa la data (fixedDate)', 'permesso', A, 'PUT', f'proposals/{fid}/fixedDate', '2099-02-01_2100')
    check("A crea l'evento fissato con B partecipante", 'permesso', A, 'PUT', f'events/{fid}', {
          'id': fid, 'date': '2099-02-01', 'title': 'Proposta di prova', 'time': '21:00', 'location': '', 'notes': '',
          'fee': 0, 'color': 'color-neutral', 'link': '', 'participants': {B['uid']: True}, 'creatorId': A['uid'], 'createdAt': now})
    check('A elimina la proposta fissata (con le sue date)', 'permesso', A, 'DELETE', f'proposals/{fid}')
    check("B scrive nella chat dell'evento fissato", 'permesso', B, 'PUT', f'eventChats/{fid}/messages/f1', msg(B, 'ci sono!'))
    check("A elimina l'evento fissato con la chat", 'permesso', A, 'PATCH', '', {f'events/{fid}': None, f'eventChats/{fid}': None})

    # Ruoli, blocchi, impostazioni e statistiche (0.5.0): utenti normali
    check('B si dà il ruolo di admin', 'bloccato', B, 'PUT', f'roles/{B["uid"]}', 'admin')
    check('B legge il proprio ruolo', 'permesso', B, 'GET', f'roles/{B["uid"]}')
    check('B legge il ruolo di A', 'bloccato', B, 'GET', f'roles/{A["uid"]}')
    check('B legge tutti i ruoli', 'bloccato', B, 'GET', 'roles')
    check('B blocca A', 'bloccato', B, 'PUT', f'blocked/{A["uid"]}', True)
    check('B legge chi è bloccato', 'bloccato', B, 'GET', 'blocked')
    check('B controlla se è bloccato', 'permesso', B, 'GET', f'blocked/{B["uid"]}')
    check('B legge le impostazioni', 'permesso', B, 'GET', 'settings')
    check('B scrive un avviso a tutti', 'bloccato', B, 'PUT', 'settings/announcement', {'text': 'hack', 'updatedAt': now})
    check('B cambia il titolo', 'bloccato', B, 'PUT', 'settings/title', {'line1': 'hack'})
    check('B aggiorna le proprie statistiche', 'permesso', B, 'PATCH', f'stats/{B["uid"]}',
          {'opens': 3, 'lastActiveAt': now, 'firstSeenAt': now, 'days/2099-01-01': True, 'messagesSent': 2})
    check('Statistica negativa', 'bloccato', B, 'PUT', f'stats/{B["uid"]}/opens', -1)
    check('Statistica sconosciuta', 'bloccato', B, 'PUT', f'stats/{B["uid"]}/minutiUso', 5)
    check('Giorno in formato sbagliato', 'bloccato', B, 'PUT', f'stats/{B["uid"]}/days/oggi', True)
    check('B scrive le statistiche di A', 'bloccato', B, 'PUT', f'stats/{A["uid"]}/opens', 99)
    check('B legge le statistiche di tutti', 'bloccato', B, 'GET', 'stats')
    check('B legge le proprie statistiche', 'permesso', B, 'GET', f'stats/{B["uid"]}')

    # Nuvolette degli omini (0.5.1): bubbles/{uid} = {text <= 10, at}
    check('B fa parlare il suo omino', 'permesso', B, 'PUT', f'bubbles/{B["uid"]}', {'text': 'Ciao a tut', 'at': now})
    check('Nuvoletta di 11 caratteri', 'bloccato', B, 'PUT', f'bubbles/{B["uid"]}', {'text': 'Ciao a tutt', 'at': now})
    check('Nuvoletta vuota', 'bloccato', B, 'PUT', f'bubbles/{B["uid"]}', {'text': '', 'at': now})
    check('Nuvoletta senza ora', 'bloccato', B, 'PUT', f'bubbles/{B["uid"]}', {'text': 'ciao'})
    check('Nuvoletta con campo sconosciuto', 'bloccato', B, 'PUT', f'bubbles/{B["uid"]}', {'text': 'ciao', 'at': now, 'x': 1})
    check('B fa parlare l\'omino di A', 'bloccato', B, 'PUT', f'bubbles/{A["uid"]}', {'text': 'finto', 'at': now})
    check('A legge le nuvolette', 'permesso', A, 'GET', 'bubbles')

    # Amministratore (solo con BACHECA_ADMIN_USER / BACHECA_ADMIN_PASS)
    if ADM:
        aid = f'claudetesta_{now}'
        check('A crea un evento per le prove admin', 'permesso', A, 'PUT', f'events/{aid}', {**ev, 'id': aid})
        check('B si iscrive (prove admin)', 'permesso', B, 'PUT', f'events/{aid}/participants/{B["uid"]}', True)
        check('B scrive in chat (prove admin)', 'permesso', B, 'PUT', f'eventChats/{aid}/messages/x1', msg(B, 'messaggio da moderare'))
        check('Admin modifica il titolo dell\'evento di A', 'permesso', ADM, 'PUT', f'events/{aid}/title', 'Moderato')
        check('Admin passa l\'evento di A a B', 'permesso', ADM, 'PUT', f'events/{aid}/creatorId', B['uid'])
        check('Admin cancella un messaggio di B', 'permesso', ADM, 'DELETE', f'eventChats/{aid}/messages/x1')
        check('Admin modifica un messaggio di B', 'bloccato', ADM, 'PUT', f'eventChats/{aid}/messages/x2', msg(B, 'finto'))
        check('Admin toglie B dai partecipanti', 'permesso', ADM, 'DELETE', f'events/{aid}/participants/{B["uid"]}')
        check('Admin legge tutte le statistiche', 'permesso', ADM, 'GET', 'stats')
        check('Admin legge chi è bloccato', 'permesso', ADM, 'GET', 'blocked')
        check('Admin legge tutti i ruoli', 'permesso', ADM, 'GET', 'roles')
        check('Admin rinomina B', 'permesso', ADM, 'PUT', f'users/{B["uid"]}/name', 'Rinominat')
        check('Admin pubblica un avviso', 'permesso', ADM, 'PUT', 'settings/announcement', {'text': 'Prova avviso', 'updatedAt': now})
        check('Avviso di 201 caratteri', 'bloccato', ADM, 'PUT', 'settings/announcement', {'text': 'A' * 201, 'updatedAt': now})
        check('Admin toglie l\'avviso', 'permesso', ADM, 'DELETE', 'settings/announcement')
        check('Admin blocca sé stesso', 'bloccato', ADM, 'PUT', f'blocked/{ADM["uid"]}', True)
        check('Admin si cambia il ruolo', 'bloccato', ADM, 'PUT', f'roles/{ADM["uid"]}', 'user')
        check('Admin blocca B', 'permesso', ADM, 'PUT', f'blocked/{B["uid"]}', True)
        check('B bloccato legge gli eventi', 'bloccato', B, 'GET', 'events')
        check('B bloccato scrive in chat', 'bloccato', B, 'PUT', f'eventChats/{eid}/messages/z1', msg(B, 'ci sono ancora'))
        check('B bloccato aggiorna le statistiche', 'bloccato', B, 'PUT', f'stats/{B["uid"]}/opens', 4)
        check('B bloccato vede di essere bloccato', 'permesso', B, 'GET', f'blocked/{B["uid"]}')
        check('Admin sblocca B', 'permesso', ADM, 'DELETE', f'blocked/{B["uid"]}')
        check('B sbloccato legge gli eventi', 'permesso', B, 'GET', 'events')
        check('Admin elimina l\'evento di altri con la chat', 'permesso', ADM, 'PATCH', '', {f'events/{aid}': None, f'eventChats/{aid}': None})
        qid = f'claudetestq_{now}'
        check('A crea una proposta per le prove admin', 'permesso', A, 'PUT', f'proposals/{qid}', {**pr, 'id': qid})
        check('Admin modifica la proposta di A', 'permesso', ADM, 'PUT', f'proposals/{qid}/title', 'Moderata')
        check('Admin elimina la proposta di A', 'permesso', ADM, 'PATCH', '', {f'proposals/{qid}': None, f'eventChats/{qid}': None})
    else:
        results.append(('⏭️', 'Prove admin saltate (manca BACHECA_ADMIN_USER / BACHECA_ADMIN_PASS)', '-', '-'))

    # Eliminazioni corrette (come fa l'app: tutto in un'unica scrittura)
    check('A elimina la proposta con chat e immagine insieme', 'permesso', A, 'PATCH', '',
          {f'proposals/{pid}': None, f'eventChats/{pid}': None, f'eventImages/{pid}': None})
    check('A elimina l\'evento con chat e immagine insieme', 'permesso', A, 'PATCH', '',
          {f'events/{eid}': None, f'eventChats/{eid}': None, f'eventImages/{eid}': None})
finally:
    # Pulizia: dati degli utenti di prova e account (prima si sblocca B, se una prova si è interrotta)
    if ADM:
        http('DELETE', f'{DB}/blocked/{B["uid"]}.json?auth={ADM["token"]}')
    for u in (A, B):
        http('DELETE', f'{DB}/presence/{u["uid"]}.json?auth={u["token"]}')
        http('DELETE', f'{DB}/chatReadStatus/{u["uid"]}.json?auth={u["token"]}')
        http('DELETE', f'{DB}/users/{u["uid"]}.json?auth={u["token"]}')
        http('DELETE', f'{DB}/stats/{u["uid"]}.json?auth={u["token"]}')
        http('DELETE', f'{DB}/bubbles/{u["uid"]}.json?auth={u["token"]}')
    # Eventi e proposte di prova ancora presenti (prova interrotta o fallita): li toglie chi li ha creati,
    # altrimenti l'admin. Senza questa pulizia restavano su TEST (titoli "TTTT…" che allargavano la pagina)
    for node in ('events', 'proposals'):
        st, items = db(A, 'GET', f'{node}')
        for key, item in (items or {}).items():
            if not key.startswith('claudetest') or not isinstance(item, dict):
                continue
            owner = A if item.get('creatorId') == A['uid'] else (B if item.get('creatorId') == B['uid'] else ADM)
            if owner:
                db(owner, 'PATCH', '', {f'{node}/{key}': None, f'eventChats/{key}': None, f'eventImages/{key}': None})
    left = []
    for path in [f'events/{eid}', f'proposals/{pid}', f'eventChats/{eid}', f'eventChats/{pid}', f'eventImages/{eid}', f'events/{fid}', f'proposals/{fid}', f'eventChats/{fid}']:
        st, val = db(A, 'GET', path)
        if val is not None: left.append(path)
    db(ADM, 'PATCH', '', {f'approved/{A["uid"]}': None, f'approved/{B["uid"]}': None})  # per ultime, dopo i controlli
    for u in (A, B):
        http('POST', f'https://identitytoolkit.googleapis.com/v1/accounts:delete?key={API_KEY}', {'idToken': u['token']})

w = max(len(r[1]) for r in results)
for r in results:
    print(f'{r[0]:<12} {r[1]:<{w}}  atteso: {r[2]:<9} esito: {r[3]}')
bad = [r for r in results if r[0] not in ('✅', '⏭️')]
print(f'\n{len(results)} prove, {len(results) - len(bad)} ok, {len(bad)} problemi')
print('Dati di prova rimasti:', left or 'nessuno')
