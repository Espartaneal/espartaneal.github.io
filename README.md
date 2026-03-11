# espartaneal.github.io
@app.route('/')
def index():
    return render_template_string(TEMPLATE)

@app.route('/add_patient', methods=['POST'])
def add_patient():
    db = get_db(); cur = db.cursor()
    name = request.form.get('name')
    age = request.form.get('age') or None
    gender = request.form.get('gender')
    phone = request.form.get('phone')
    lat = request.form.get('lat') or None
    lon = request.form.get('lon') or None
    blood_sugar = request.form.get('blood_sugar') or None
    blood_pressure = request.form.get('blood_pressure') or None
    chronic_conditions = request.form.get('chronic_conditions') or ''
    medications = request.form.get('medications') or ''
    comments = request.form.get('comments') or ''
    doctor_name = request.form.get('doctor_name') or ''
    now = datetime.datetime.utcnow().isoformat()

    cur.execute('INSERT INTO patients (name, age, gender, phone, lat, lon, blood_sugar, blood_pressure, chronic_conditions, medications, comments, created_at, last_updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (name, age, gender, phone, lat or None, lon or None, blood_sugar, blood_pressure, chronic_conditions, medications, comments, now, now))
    pid = cur.lastrowid
    patient_code = f"P{pid:05d}"
    cur.execute('UPDATE patients SET patient_code = ? WHERE id = ?', (patient_code, pid))
    # history (create)
    cur.execute('INSERT INTO patient_history (patient_id, snapshot_time, doctor_name, name, age, gender, blood_sugar, blood_pressure, chronic_conditions, medications, comments, operation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                (pid, now, doctor_name, name, age, gender, blood_sugar, blood_pressure, chronic_conditions, medications, comments, 'create'))
    db.commit()
    return redirect(url_for('index'))

@app.route('/upload', methods=['POST'])
def upload():
    file = request.files.get('file')
    if not file: return redirect(url_for('index'))
    try: df = pd.read_csv(file)
    except: return redirect(url_for('index'))
    db = get_db(); cur = db.cursor()
    now = datetime.datetime.utcnow().isoformat()
    for _, row in df.iterrows():
        name = row.get('name') or row.get('Name')
        age = row.get('age') or None
        gender = row.get('gender') or ''
        lat = row.get('lat') or None
        lon = row.get('lon') or None
        blood_sugar = row.get('blood_sugar') or None
        blood_pressure = row.get('blood_pressure') or None
        chronic_conditions = row.get('chronic_conditions') or ''
        medications = row.get('medications') or ''
        comments = row.get('comments') or ''
        cur.execute('INSERT INTO patients (name, age, gender, phone, lat, lon, blood_sugar, blood_pressure, chronic_conditions, medications, comments, created_at, last_updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                    (name, age, gender, None, lat, lon, blood_sugar, blood_pressure, chronic_conditions, medications, comments, now, now))
        pid = cur.lastrowid
        patient_code = f"P{pid:05d}"
        cur.execute('UPDATE patients SET patient_code = ? WHERE id = ?', (patient_code, pid))
        cur.execute('INSERT INTO patient_history (patient_id, snapshot_time, doctor_name, name, age, gender, blood_sugar, blood_pressure, chronic_conditions, medications, comments, operation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                    (pid, now, '', name, age, gender, blood_sugar, blood_pressure, chronic_conditions, medications, comments, 'create'))
    db.commit()
    return redirect(url_for('index'))

@app.route('/seed')
def seed():
    # sample with fixed patient_code generation (works if DB already has rows)
    sample = [
        ('Juan dela Cruz', 68, 'M', 10.700, 123.930, 220, 150, 'hypertension,diabetes', 'metformin', 'Follow-up in 2 weeks'),
        ('Maria Santos', 52, 'F', 10.703, 123.935, 180, 135, 'diabetes', 'insulin', 'Adjust dose if fasting>160'),
        ('Pedro', 35, 'M', 10.705, 123.927, 125, 120, '', '', ''),
        ('Ana', 42, 'F', 10.699, 123.940, 155, 128, '', 'metformin', 'Monitor diet'),
        ('Lito', 58, 'M', 10.708, 123.922, 240, 160, 'heart disease,diabetes', 'aspirin,insulin', 'Urgent referral'),
    ]
    db = get_db(); cur = db.cursor()
    now = datetime.datetime.utcnow().isoformat()
    for s in sample:
        cur.execute('INSERT INTO patients (name, age, gender, lat, lon, blood_sugar, blood_pressure, chronic_conditions, medications, comments, created_at, last_updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                    (s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], now, now))
        pid = cur.lastrowid
        patient_code = f"P{pid:05d}"
        cur.execute('UPDATE patients SET patient_code = ? WHERE id = ?', (patient_code, pid))
        # record history
        cur.execute('INSERT INTO patient_history (patient_id, snapshot_time, doctor_name, name, age, gender, blood_sugar, blood_pressure, chronic_conditions, medications, comments, operation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                    (pid, now, 'seed', s[0], s[1], s[2], s[5], s[6], s[7], s[8], s[9], 'create'))
    db.commit()
    return redirect(url_for('index'))

# -------------------------
# API: summary
# -------------------------
@app.route('/api/summary')
def api_summary():
    show_deleted = request.args.get('show_deleted', '0') == '1'
    db = get_db(); cur = db.cursor()
    if show_deleted:
        cur.execute('SELECT * FROM patients ORDER BY id')
    else:
        cur.execute('SELECT * FROM patients WHERE is_deleted = 0 ORDER BY id')
    rows = [dict(x) for x in cur.fetchall()]

    records=[]; points=[]; highrisk=[]
    low=mid=high=0; total_bs=0; bs_count=0; total_bp=0; bp_count=0

    for r in rows:
        age = r.get('age'); bs = r.get('blood_sugar'); bp = r.get('blood_pressure')
        risk = compute_risk_score_dict(age, bs, bp)
        rec = {
            'id': r.get('id'), 'patient_code': r.get('patient_code'),
            'name': r.get('name'), 'age': age, 'blood_sugar': bs, 'blood_pressure': bp,
            'chronic_conditions': r.get('chronic_conditions') or '', 'medications': r.get('medications') or '',
            'comments': r.get('comments') or '', 'created_at': r.get('created_at'), 'last_updated': r.get('last_updated'),
            'is_deleted': r.get('is_deleted') or 0, 'deleted_at': r.get('deleted_at')
        }
        rec['risk'] = risk
        records.append(rec)
        if r.get('lat') and r.get('lon') and (r.get('is_deleted')==0):
            try:
                lat = float(r.get('lat')); lon = float(r.get('lon'))
                points.append({**rec, 'lat': lat, 'lon': lon})
            except:
                pass
        if risk >= 7:
            high += 1; highrisk.append(rec)
        elif risk >= 4:
            mid += 1
        else:
            low += 1
        if bs is not None and str(bs).strip()!='':
            try: total_bs += float(bs); bs_count += 1
            except: pass
        if bp is not None and str(bp).strip()!='':
            try: total_bp += float(bp); bp_count += 1
            except: pass

    avg_bs = round(total_bs/bs_count,1) if bs_count else None
    avg_bp = round(total_bp/bp_count,1) if bp_count else None
    return jsonify({'records':records, 'points':points, 'highrisk':highrisk, 'counts':{'low':low,'mid':mid,'high':high,'total':len(records),'highcount':len(highrisk),'avg_bs':avg_bs,'avg_bp':avg_bp}})

# -------------------------
# API: single patient by id/code
# -------------------------
@app.route('/api/patient/<int:pid>')
def api_patient(pid):
    db = get_db(); cur = db.cursor()
    cur.execute('SELECT * FROM patients WHERE id = ?', (pid,))
    r = cur.fetchone()
    if not r: return ('Not found', 404)
    return jsonify(dict(r))

@app.route('/api/patient_code/<code>')
def api_patient_code(code):
    db = get_db(); cur = db.cursor()
    cur.execute('SELECT * FROM patients WHERE patient_code = ?', (code,))
    r = cur.fetchone()
    if not r: return ('Not found', 404)
    return jsonify(dict(r))

# -------------------------
# API: history list for a patient
# -------------------------
@app.route('/api/history/<int:pid>')
def api_history(pid):
    db = get_db(); cur = db.cursor()
    cur.execute('SELECT * FROM patient_history WHERE patient_id = ? ORDER BY snapshot_time DESC', (pid,))
    rows = [dict(x) for x in cur.fetchall()]
    return jsonify(rows)

# -------------------------
# Update patient (create history snapshot of previous state)
# -------------------------
@app.route('/update_patient', methods=['POST'])
def update_patient():
    pid = request.form.get('id')
    if not pid: return ('Bad Request', 400)
    db = get_db(); cur = db.cursor()
    cur.execute('SELECT * FROM patients WHERE id = ?', (pid,))
    old = cur.fetchone()
    if not old: return ('Not found', 404)
    oldd = dict(old)
    now = datetime.datetime.utcnow().isoformat()
    doctor_name = request.form.get('doctor_name') or ''
    # save snapshot of old state
    cur.execute('INSERT INTO patient_history (patient_id, snapshot_time, doctor_name, name, age, gender, blood_sugar, blood_pressure, chronic_conditions, medications, comments, operation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                (pid, now, doctor_name, oldd.get('name'), oldd.get('age'), oldd.get('gender'), oldd.get('blood_sugar'), oldd.get('blood_pressure'), oldd.get('chronic_conditions'), oldd.get('medications'), oldd.get('comments'), 'update'))
    # now update
    name = request.form.get('name'); age = request.form.get('age') or None; gender = request.form.get('gender')
    lat = request.form.get('lat') or None; lon = request.form.get('lon') or None
    blood_sugar = request.form.get('blood_sugar') or None; blood_pressure = request.form.get('blood_pressure') or None
    chronic_conditions = request.form.get('chronic_conditions') or ''
    medications = request.form.get('medications') or ''
    comments = request.form.get('comments') or ''
    last_up = now
    cur.execute('UPDATE patients SET name=?, age=?, gender=?, lat=?, lon=?, blood_sugar=?, blood_pressure=?, chronic_conditions=?, medications=?, comments=?, last_updated=? WHERE id=?',
                (name, age, gender, lat or None, lon or None, blood_sugar, blood_pressure, chronic_conditions, medications, comments, last_up, pid))
    db.commit()
    return redirect(url_for('index'))

# -------------------------
# Soft delete (with history snapshot)
# -------------------------
@app.route('/delete_patient', methods=['POST'])
def delete_patient():
    data = request.get_json()
    if not data or 'id' not in data: return ('Bad Request', 400)
    pid = int(data['id']); doctor_name = data.get('doctor_name') or ''
    db = get_db(); cur = db.cursor()
    cur.execute('SELECT * FROM patients WHERE id = ?', (pid,))
    old = cur.fetchone()
    if not old: return ('Not found', 404)
    now = datetime.datetime.utcnow().isoformat()
    cur.execute('INSERT INTO patient_history (patient_id, snapshot_time, doctor_name, name, age, gender, blood_sugar, blood_pressure, chronic_conditions, medications, comments, operation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                (pid, now, doctor_name, old['name'], old['age'], old['gender'], old['blood_sugar'], old['blood_pressure'], old['chronic_conditions'], old['medications'], old['comments'], 'delete'))
    cur.execute('UPDATE patients SET is_deleted=1, deleted_at=? WHERE id = ?', (now, pid))
    db.commit()
    return ('OK', 200)

# -------------------------
# Restore (undo soft-delete)
# -------------------------
@app.route('/restore_patient', methods=['POST'])
def restore_patient():
    data = request.get_json()
    if not data or 'id' not in data: return ('Bad Request', 400)
    pid = int(data['id']); doctor_name = data.get('doctor_name') or ''
    db = get_db(); cur = db.cursor()
    cur.execute('SELECT * FROM patients WHERE id = ?', (pid,))
    old = cur.fetchone()
    if not old: return ('Not found', 404)
    now = datetime.datetime.utcnow().isoformat()
    cur.execute('INSERT INTO patient_history (patient_id, snapshot_time, doctor_name, name, age, gender, blood_sugar, blood_pressure, chronic_conditions, medications, comments, operation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                (pid, now, doctor_name, old['name'], old['age'], old['gender'], old['blood_sugar'], old['blood_pressure'], old['chronic_conditions'], old['medications'], old['comments'], 'restore'))
    cur.execute('UPDATE patients SET is_deleted=0, deleted_at=NULL, last_updated=? WHERE id = ?', (now, pid))
    db.commit()
    return ('OK', 200)

# -------------------------
# Hard delete (permanent)
# -------------------------
@app.route('/hard_delete', methods=['POST'])
def hard_delete():
    data = request.get_json()
    if not data or 'id' not in data: return ('Bad Request', 400)
    pid = int(data['id'])
    db = get_db(); cur = db.cursor()
    cur.execute('DELETE FROM patient_history WHERE patient_id = ?', (pid,))
    cur.execute('DELETE FROM patients WHERE id = ?', (pid,))
    db.commit()
    return ('OK', 200)

# -------------------------
# Export CSV
# -------------------------
@app.route('/export')
def export_csv():
    df = pd.read_sql_query('SELECT * FROM patients', get_db())
    buf = io.StringIO(); df.to_csv(buf, index=False); buf.seek(0)
    return send_file(io.BytesIO(buf.getvalue().encode()), mimetype='text/csv', as_attachment=True, download_name='village_health_export.csv')

# -------------------------
# Run
# -------------------------
if __name__ == '__main__':
    app.run(debug=True)
