# espartaneal.github.io
from flask import Flask, request, g, redirect, url_for, render_template_string, send_file, jsonify
import sqlite3, os, datetime, pandas as pd, io, json

DB_PATH = 'village_health_map.db'
app = Flask(__name__)
app.config['SECRET_KEY'] = 'dev'

# -------------------------
# DB helpers and schema
# -------------------------
def get_db():
    db = getattr(g, '_database', None)
    if db is None:
        need_init = not os.path.exists(DB_PATH)
        db = g._database = sqlite3.connect(DB_PATH)
        db.row_factory = sqlite3.Row
        if need_init:
            init_db(db)
    return db

def init_db(db):
    cur = db.cursor()
    cur.execute('''
        CREATE TABLE patients (
            id INTEGER PRIMARY KEY,
            patient_code TEXT UNIQUE,
            name TEXT,
            age INTEGER,
            gender TEXT,
            phone TEXT,
            lat REAL,
            lon REAL,
            blood_sugar REAL,
            blood_pressure REAL,
            chronic_conditions TEXT,
            medications TEXT,
            comments TEXT,
            is_deleted INTEGER DEFAULT 0,
            deleted_at TEXT,
            created_at TEXT,
            last_updated TEXT
        )
    ''')
    cur.execute('''
        CREATE TABLE patient_history (
            id INTEGER PRIMARY KEY,
            patient_id INTEGER,
            snapshot_time TEXT,
            doctor_name TEXT,
            name TEXT,
            age INTEGER,
            gender TEXT,
            blood_sugar REAL,
            blood_pressure REAL,
            chronic_conditions TEXT,
            medications TEXT,
            comments TEXT,
            operation TEXT,
            FOREIGN KEY(patient_id) REFERENCES patients(id)
        )
    ''')
    db.commit()

@app.teardown_appcontext
def close_connection(exception):
    db = getattr(g, '_database', None)
    if db is not None:
        db.close()

# -------------------------
# risk scoring
# -------------------------
def compute_risk_score_dict(age, blood_sugar, blood_pressure):
    score = 0
    try:
        bs = float(blood_sugar) if blood_sugar is not None else 0
    except:
        bs = 0
    if bs >= 200: score += 5
    elif bs >= 140: score += 3
    elif bs >= 70: score += 1

    try:
        a = int(age) if age is not None else 0
    except:
        a = 0
    if a > 65: score += 3
    elif a > 50: score += 2
    elif a > 30: score += 1

    try:
        bp = float(blood_pressure) if blood_pressure is not None else 0
    except:
        bp = 0
    if bp > 140: score += 2
    elif bp > 130: score += 1

    return min(10, int(score))

# -------------------------
# Template (single-file HTML + JS)
# -------------------------
TEMPLATE = r'''
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Village Health Map v3</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;600;700&display=swap" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css" />
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css" />
<style>
  body { font-family: 'Poppins', system-ui, -apple-system, 'Segoe UI', Roboto, Arial; background:#f6f9fb; }
  .card-compact { border-radius:12px; box-shadow:0 6px 18px rgba(20,40,60,0.06); }
  #map { height:520px; border-radius:10px; }
  .navbar-brand { font-weight:700; }
  .footer { font-size:0.85rem; color:#666; }
  .btn-primary { background:#0d9488; border-color:#0d9488; }
  .deleted-row { background:#fff3f3; }
  .diff-old { background:#ffecec; padding:4px; border-radius:4px; }
  .diff-new { background:#e8ffea; padding:4px; border-radius:4px; }
  .muted-small { font-size:0.85rem; color:#666; }
  .doctor-input { width:220px; margin-right:8px; }
</style>
</head>
<body>
<nav class="navbar navbar-expand-lg bg-white mb-3 shadow-sm">
  <div class="container">
    <a class="navbar-brand" href="#">Village Health Map v3</a>
    <div class="d-flex align-items-center">
      <input id="doctorName" class="form-control doctor-input" placeholder="Doctor name" title="Enter your name"/>
      <button class="btn btn-outline-secondary me-2" onclick="saveDoctor()">Save</button>
      <a class="btn btn-outline-secondary me-2" href="/export">Export CSV</a>
      <a class="btn btn-outline-info me-2" href="/seed">Seed Sample Data</a>
      <a class="btn btn-outline-danger" href="#footer">About</a>
    </div>
  </div>
</nav>

<div class="container">
  <div class="row g-3 mb-3">
    <div class="col-md-3"><div class="card card-compact p-3"><h6>Total Patients</h6><h2 id="totalPatients">--</h2></div></div>
    <div class="col-md-3"><div class="card card-compact p-3"><h6>High Risk</h6><h2 id="highRiskCount">--</h2></div></div>
    <div class="col-md-3"><div class="card card-compact p-3"><h6>Avg Blood Sugar</h6><h2 id="avgSugar">--</h2></div></div>
    <div class="col-md-3"><div class="card card-compact p-3"><h6>Avg Blood Pressure</h6><h2 id="avgBP">--</h2></div></div>
  </div>

  <div class="row">
    <div class="col-lg-4">
      <div class="card p-3 mb-3 card-compact">
        <h5>Add Patient (Manual)</h5>
        <form id="addForm" method="post" action="/add_patient">
          <input name="doctor_name" id="add_doctor" type="hidden" />
          <div class="mb-2"><input class="form-control" name="name" placeholder="Full name" required></div>
          <div class="mb-2 row"><div class="col"><input class="form-control" name="age" placeholder="Age" type="number"></div><div class="col"><input class="form-control" name="gender" placeholder="Gender"></div></div>
          <div class="mb-2 row"><div class="col"><input class="form-control" name="blood_sugar" placeholder="Blood sugar (mg/dL)" type="number" step="any"></div><div class="col"><input class="form-control" name="blood_pressure" placeholder="Systolic BP" type="number" step="any"></div></div>
          <div class="mb-2 row"><div class="col"><input class="form-control" name="lat" placeholder="Latitude (optional)"></div><div class="col"><input class="form-control" name="lon" placeholder="Longitude (optional)"></div></div>
          <div class="mb-2"><input class="form-control" name="chronic_conditions" placeholder="Chronic conditions (comma-separated)"></div>
          <div class="mb-2"><input class="form-control" name="medications" placeholder="Medications / notes"></div>
          <div class="mb-2"><input class="form-control" name="comments" placeholder="Initial comments (doctor notes)"></div>
          <div class="d-flex gap-2"><button class="btn btn-primary">Add</button><button type="reset" class="btn btn-outline-secondary">Clear</button></div>
        </form>
      </div>

      <div class="card p-3 mb-3 card-compact">
        <h5>Import CSV</h5>
        <form method="post" action="/upload" enctype="multipart/form-data">
          <div class="mb-2"><input class="form-control" type="file" name="file" accept=".csv" required></div>
          <div class="mb-2"><small>CSV columns: name,age,gender,blood_sugar,blood_pressure,lat,lon,chronic_conditions,medications,comments</small></div>
          <div><button class="btn btn-success">Upload</button></div>
        </form>
      </div>

      <div class="card p-3 mb-3 card-compact">
        <h5>High Risk Individuals</h5>
        <div id="highRiskList"></div>
      </div>
    </div>

    <div class="col-lg-8">
      <div class="d-flex mb-2 gap-2">
        <input id="searchInput" class="form-control" placeholder="Search by Patient Code (e.g. P00001)"/>
        <div class="form-check form-switch ms-2"><input class="form-check-input" id="showDeletedToggle" type="checkbox"><label class="form-check-label" for="showDeletedToggle">Show Deleted</label></div>
        <div class="form-check form-switch"><input class="form-check-input" id="heatToggle" type="checkbox"><label class="form-check-label" for="heatToggle">Heatmap</label></div>
      </div>

      <div class="card p-3 card-compact mb-3"><div id="map"></div></div>
      <div class="card p-3 card-compact"><h5>Risk Distribution</h5><canvas id="riskChart" height="100"></canvas></div>
    </div>
  </div>

  <hr>
  <h5>All Records</h5>
  <div class="table-responsive mb-3">
    <table class="table table-sm" id="recordsTable">
      <thead><tr><th>Code</th><th>Name</th><th>Age</th><th>BS</th><th>BP</th><th>Risk</th><th>Last Updated</th><th>Actions</th></tr></thead>
      <tbody id="recordsBody"></tbody>
    </table>
  </div>

  <footer id="footer" class="pt-4 footer">Village Health Map — SIGHT Team Prototype</footer>
</div>

<!-- Update modal -->
<div class="modal fade" id="updateModal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog modal-lg">
    <form id="updateForm" class="modal-content" method="post" action="/update_patient">
      <div class="modal-header"><h5 class="modal-title">Update Patient</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">
        <input type="hidden" name="id" id="upd_id">
        <input type="hidden" name="doctor_name" id="upd_doctor">
        <div class="row g-2">
          <div class="col-md-6"><label class="form-label">Patient Code</label><input id="upd_code" class="form-control" disabled></div>
          <div class="col-md-6"><label class="form-label">Last Updated</label><input id="upd_last" class="form-control" disabled></div>
          <div class="col-md-6"><label class="form-label">Name</label><input id="upd_name" name="name" class="form-control" required></div>
          <div class="col-md-3"><label class="form-label">Age</label><input id="upd_age" name="age" class="form-control" type="number"></div>
          <div class="col-md-3"><label class="form-label">Gender</label><input id="upd_gender" name="gender" class="form-control"></div>
          <div class="col-md-6"><label class="form-label">Blood Sugar</label><input id="upd_bs" name="blood_sugar" class="form-control" type="number" step="any"></div>
          <div class="col-md-6"><label class="form-label">Blood Pressure</label><input id="upd_bp" name="blood_pressure" class="form-control" type="number" step="any"></div>
          <div class="col-md-6"><label class="form-label">Latitude</label><input id="upd_lat" name="lat" class="form-control"></div>
          <div class="col-md-6"><label class="form-label">Longitude</label><input id="upd_lon" name="lon" class="form-control"></div>
          <div class="col-12"><label class="form-label">Chronic Conditions</label><input id="upd_cc" name="chronic_conditions" class="form-control"></div>
          <div class="col-12"><label class="form-label">Medications</label><input id="upd_med" name="medications" class="form-control"></div>
          <div class="col-12"><label class="form-label">Comments / Doctor notes</label><textarea id="upd_comments" name="comments" rows="3" class="form-control"></textarea></div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" id="viewHistoryBtn" class="btn btn-outline-secondary me-auto">View History</button>
        <button type="submit" class="btn btn-primary">Save changes</button>
        <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
      </div>
    </form>
  </div>
</div>

<!-- History modal -->
<div class="modal fade" id="historyModal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog modal-xl"><div class="modal-content">
    <div class="modal-header"><h5 class="modal-title">Patient History</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
      <div class="mb-3"><small class="muted-small">Select two snapshots and click Compare to see a field-by-field diff.</small></div>
      <div id="historyList" class="mb-3"></div>
      <div class="d-flex gap-2 mb-3">
        <select id="histA" class="form-select"></select>
        <select id="histB" class="form-select"></select>
        <button id="compareBtn" class="btn btn-primary">Compare</button>
      </div>
      <div id="diffResult"></div>
    </div>
    <div class="modal-footer"><button class="btn btn-outline-secondary" data-bs-dismiss="modal">Close</button></div>
  </div></div>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
<script src="https://unpkg.com/leaflet.heat/dist/leaflet-heat.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>

<script>
// Utility: doctor name saved in localStorage
function loadDoctor(){
  const d = localStorage.getItem('doctor_name') || '';
  document.getElementById('doctorName').value = d;
  document.getElementById('add_doctor').value = d;
  document.getElementById('upd_doctor').value = d;
}
function saveDoctor(){
  const v = document.getElementById('doctorName').value.trim();
  localStorage.setItem('doctor_name', v);
  document.getElementById('add_doctor').value = v;
  document.getElementById('upd_doctor').value = v;
  alert('Doctor name saved locally.');
}
loadDoctor();

// auto-fill hidden doctor field on add submit
document.getElementById('addForm').addEventListener('submit', function(){ document.getElementById('add_doctor').value = localStorage.getItem('doctor_name') || ''; });

// fetch summary
async function fetchData(showDeleted=false){
  const r = await fetch('/api/summary?show_deleted=' + (showDeleted?1:0));
  return r.json();
}
function riskToColor(risk){
  const clamped = Math.max(0, Math.min(10, risk));
  const hue = 120 - (clamped/10)*120;
  return `hsl(${hue},75%,45%)`;
}

let globalMap=null, clusterGrp=null, heatLayer=null;
function createMap(points, useHeat){
  if(globalMap){ globalMap.remove(); globalMap=null; clusterGrp=null; heatLayer=null; }
  const center = points.length ? [points[0].lat, points[0].lon] : [10.702,123.933];
  globalMap = L.map('map').setView(center, 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(globalMap);
  clusterGrp = L.markerClusterGroup();
  const heatPts = [];
  points.forEach(p=>{
    if(!p.lat || !p.lon) return;
    const color = riskToColor(p.risk);
    const size = 6 + (p.risk/10)*12;
    const marker = L.circleMarker([p.lat,p.lon], {radius:size, color:color, fillColor:color, fillOpacity:0.8});
    const html = `<b>${p.patient_code} — ${p.name}</b><br>Risk: ${p.risk}<br>BS:${p.blood_sugar||'-'} BP:${p.blood_pressure||'-'}<br>${p.chronic_conditions||''}<br><small>${p.comments||''}</small>`;
    marker.bindPopup(html);
    clusterGrp.addLayer(marker);
    heatPts.push([p.lat,p.lon, Math.max(0.2, p.risk/10)]);
  });
  globalMap.addLayer(clusterGrp);
  heatLayer = L.heatLayer(heatPts, {radius:25, blur:15, maxZoom:17});
  if(useHeat){ globalMap.addLayer(heatLayer); globalMap.removeLayer(clusterGrp); }
}

function populate(data, showDeleted=false){
  document.getElementById('totalPatients').innerText = data.counts.total;
  document.getElementById('highRiskCount').innerText = data.counts.high;
  document.getElementById('avgSugar').innerText = data.counts.avg_bs || '-';
  document.getElementById('avgBP').innerText = data.counts.avg_bp || '-';

  const tbody = document.getElementById('recordsBody'); tbody.innerHTML = '';
  data.records.forEach(r=>{
    const tr = document.createElement('tr');
    if(r.is_deleted) tr.classList.add('deleted-row');
    const last_up = r.last_updated? r.last_updated.replace('T',' ') : '';
    let actions = '';
    if(!r.is_deleted){
      actions = `<button class="btn btn-sm btn-outline-primary me-1" onclick="openUpdate(${r.id})">Update</button>
                 <button class="btn btn-sm btn-outline-danger me-1" onclick="deletePatient(${r.id}, '${r.patient_code}')">Delete</button>`;
    } else {
      actions = `<button class="btn btn-sm btn-outline-success me-1" onclick="restorePatient(${r.id})">Restore</button>
                 <button class="btn btn-sm btn-outline-danger me-1" onclick="hardDelete(${r.id})">Delete Permanently</button>`;
    }
    tr.innerHTML = `<td>${r.patient_code}</td><td>${r.name}</td><td>${r.age||''}</td><td>${r.blood_sugar||''}</td><td>${r.blood_pressure||''}</td><td>${r.risk}</td><td>${last_up}</td>
    <td>${actions}<button class="btn btn-sm btn-outline-secondary ms-1" onclick="viewHistory(${r.id})">History</button></td>`;
    tbody.appendChild(tr);
  });

  // high risk
  const hr = document.getElementById('highRiskList'); hr.innerHTML = '';
  data.highrisk.forEach(h=>{
    const d = document.createElement('div'); d.className='mb-2 p-2 border rounded';
    d.innerHTML = `<div class="d-flex justify-content-between"><div><b>${h.patient_code} — ${h.name}</b><br/><small>Risk ${h.risk} • BS:${h.blood_sugar||'-'}</small></div><div><a href="#" onclick="openUpdate(${h.id})">View / Edit</a></div></div>`;
    hr.appendChild(d);
  });

  // chart
  const ctx = document.getElementById('riskChart').getContext('2d');
  if(window._riskChart) window._riskChart.destroy();
  window._riskChart = new Chart(ctx, {type:'bar', data:{labels:['Low','Medium','High'], datasets:[{label:'People', data:[data.counts.low, data.counts.mid, data.counts.high]}]}});

  // map
  const useHeat = document.getElementById('heatToggle').checked;
  createMap(data.points, useHeat);
}

// initial load
let showDeleted = false;
(async ()=>{ const data = await fetchData(showDeleted); populate(data, showDeleted); })();

async function openUpdate(id){
  const resp = await fetch('/api/patient/' + id);
  if(!resp.ok){ alert('Failed to load patient'); return; }
  const p = await resp.json();
  document.getElementById('upd_id').value = p.id;
  document.getElementById('upd_code').value = p.patient_code || '';
  document.getElementById('upd_last').value = p.last_updated || '';
  document.getElementById('upd_name').value = p.name || '';
  document.getElementById('upd_age').value = p.age || '';
  document.getElementById('upd_gender').value = p.gender || '';
  document.getElementById('upd_bs').value = p.blood_sugar || '';
  document.getElementById('upd_bp').value = p.blood_pressure || '';
  document.getElementById('upd_lat').value = p.lat || '';
  document.getElementById('upd_lon').value = p.lon || '';
  document.getElementById('upd_cc').value = p.chronic_conditions || '';
  document.getElementById('upd_med').value = p.medications || '';
  document.getElementById('upd_comments').value = p.comments || '';
  document.getElementById('upd_doctor').value = localStorage.getItem('doctor_name') || '';
  const modal = new bootstrap.Modal(document.getElementById('updateModal')); modal.show();
}

document.getElementById('updateForm').addEventListener('submit', async function(e){
  e.preventDefault();
  const form = e.target;
  const data = new FormData(form);
  // attach doctor name if missing
  if(!data.get('doctor_name')) data.set('doctor_name', localStorage.getItem('doctor_name') || '');
  const resp = await fetch('/update_patient', {method:'POST', body: data});
  if(resp.ok){ location.reload(); } else { alert('Update failed'); }
});

async function viewHistory(id){
  const resp = await fetch('/api/history/' + id);
  if(!resp.ok){ alert('No history'); return; }
  const arr = await resp.json();
  const list = document.getElementById('historyList'); list.innerHTML = '';
  const selA = document.getElementById('histA'); const selB = document.getElementById('histB');
  selA.innerHTML = ''; selB.innerHTML = ''; document.getElementById('diffResult').innerHTML = '';
  if(arr.length===0){ list.innerHTML = '<p>No history</p>'; }
  arr.forEach(h=>{
    const div = document.createElement('div'); div.className='mb-2 p-2 border rounded';
    div.innerHTML = `<b>${h.snapshot_time.replace('T',' ')} — ${h.operation} — ${h.doctor_name || '-'}</b><br>
      <small>Name:</small> ${h.name || '-'} &nbsp; <small>Age:</small> ${h.age || '-'} &nbsp; <small>BS:</small> ${h.blood_sugar||'-'} &nbsp; <small>BP:</small> ${h.blood_pressure||'-'}<br>
      <small>Conditions:</small> ${h.chronic_conditions||'-'}<br>
      <small>Medications:</small> ${h.medications||'-'}<br>
      <small>Comments:</small> ${h.comments||'-'}`;
    list.appendChild(div);
    const opt = document.createElement('option'); opt.value = JSON.stringify(h); opt.text = `${h.snapshot_time} — ${h.operation} — ${h.doctor_name||'-'}`;
    selA.appendChild(opt.cloneNode(true)); selB.appendChild(opt);
  });
  const histModal = new bootstrap.Modal(document.getElementById('historyModal')); histModal.show();
}

function showDiff(objA, objB){
  const keys = ['name','age','gender','blood_sugar','blood_pressure','chronic_conditions','medications','comments'];
  const out = document.getElementById('diffResult'); out.innerHTML = '';
  keys.forEach(k=>{
    const a = objA[k]===null? '' : String(objA[k]);
    const b = objB[k]===null? '' : String(objB[k]);
    const row = document.createElement('div'); row.className='mb-2';
    if(a === b){
      row.innerHTML = `<b>${k}:</b> ${a || '-'}`
    } else {
      row.innerHTML = `<b>${k}:</b> <span class="diff-old">${a||'-'}</span>  →  <span class="diff-new">${b||'-'}</span>`;
    }
    out.appendChild(row);
  });
  // also show metadata
  const meta = document.createElement('div'); meta.className='mt-3 muted-small';
  meta.innerHTML = `<b>Left:</b> ${objA.snapshot_time} (${objA.operation}) by ${objA.doctor_name||'-'} &nbsp; <b>Right:</b> ${objB.snapshot_time} (${objB.operation}) by ${objB.doctor_name||'-'}`;
  out.prepend(meta);
}

// compare button
document.getElementById('compareBtn').addEventListener('click', function(){
  const a = document.getElementById('histA').value;
  const b = document.getElementById('histB').value;
  if(!a || !b){ alert('Select two snapshots'); return; }
  const objA = JSON.parse(a), objB = JSON.parse(b);
  showDiff(objA, objB);
});

// delete (soft)
async function deletePatient(id, code){
  if(!confirm('Soft-delete ' + code + '?')) return;
  const resp = await fetch('/delete_patient', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id, doctor_name: localStorage.getItem('doctor_name')||''})});
  if(resp.ok) location.reload(); else alert('Delete failed');
}

// restore
async function restorePatient(id){
  const resp = await fetch('/restore_patient', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id, doctor_name: localStorage.getItem('doctor_name')||''})});
  if(resp.ok) location.reload(); else alert('Restore failed');
}

// hard delete
async function hardDelete(id){
  if(!confirm('Permanently delete?')) return;
  const resp = await fetch('/hard_delete', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id})});
  if(resp.ok) location.reload(); else alert('Hard delete failed');
}

// search
document.getElementById('searchInput').addEventListener('keydown', async function(e){
  if(e.key==='Enter'){
    const code = e.target.value.trim(); if(!code) return;
    const resp = await fetch('/api/patient_code/' + encodeURIComponent(code));
    if(resp.status===404){ alert('Not found'); return; }
    const p = await resp.json(); openUpdate(p.id);
  } else if(e.key==='Escape'){ e.target.value=''; }
});

// toggles
document.getElementById('showDeletedToggle').addEventListener('change', async function(e){
  showDeleted = e.target.checked;
  const data = await fetchData(showDeleted); populate(data, showDeleted);
});
document.getElementById('heatToggle').addEventListener('change', async function(e){
  const data = await fetchData(showDeleted); populate(data, showDeleted);
});
</script>
</body>
</html>
'''

# -------------------------
# Routes: index, add, upload, seed
# -------------------------
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
