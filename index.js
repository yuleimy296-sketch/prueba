// ==========================================
// CONFIGURACIÓN
// ==========================================
// URL de tu implementación de Apps Script (termina en /exec)
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxvOobu9X2rwu5Pu665Gb6JOerQzu77muZpBB32iEaKIucHbtrk7Gxl1hxO1PCWQojd/exec';

// ==========================================
// ESTADO GLOBAL DE LA APLICACIÓN
// ==========================================
let examsBank = [];              // Banco de exámenes (copia local del docente)
let currentExamQuestions = [];   // Preguntas del examen en edición
let editingExamId = null;        // ID de examen en edición
let activeExamForPreview = null; // Examen en curso
let evaluationHistory = [];      // Historial local de intentos

// Control de presentación
let studentName = '';
let exitAttemptsCount = 0;
let secondsElapsed = 0;
let timerInterval = null;
let examStartTs = 0;
let isPreviewMode = false;       // true cuando el docente prueba el examen
let pendingExam = null;          // examen esperando que el estudiante ponga su nombre

// ==========================================
// UTILIDADES
// ==========================================
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function showStudentModule() {
  const t = document.getElementById('teacherModule');
  const s = document.getElementById('studentModule');
  if (t) t.style.display = 'none';
  if (s) {
    s.classList.remove('hidden');
    s.style.display = 'block';
  }
}

function showTeacherModule() {
  const t = document.getElementById('teacherModule');
  const s = document.getElementById('studentModule');
  if (s) s.style.display = 'none';
  if (t) {
    t.classList.remove('hidden');
    t.style.display = 'block';
  }
}

// ==========================================
// COMUNICACIÓN CON GOOGLE APPS SCRIPT
// ==========================================
// GET: se usa para que el estudiante descargue el examen
async function apiGet(params) {
  const url = SCRIPT_URL + '?' + new URLSearchParams(params).toString();
  const res = await fetch(url);
  return await res.json();
}

// POST: el body va como texto plano (sin cabeceras) para evitar problemas de CORS
async function apiPost(payload) {
  const res = await fetch(SCRIPT_URL, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  return await res.json();
}

// ---- Clave del docente (se guarda solo en el navegador del docente) ----
function getTeacherKey() {
  let key = localStorage.getItem('teacher_key');
  if (!key) {
    key = prompt('Ingresa tu clave de docente (la misma TEACHER_KEY de Code.gs):');
    if (key && key.trim()) localStorage.setItem('teacher_key', key.trim());
  }
  return key ? key.trim() : null;
}

async function publishExamToSheets(exam) {
  const key = getTeacherKey();
  if (!key) return { ok: false, error: 'No ingresaste la clave de docente' };
  try {
    const r = await apiPost({ action: 'saveExam', key, exam });
    if (!r.ok && /clave/i.test(r.error || '')) localStorage.removeItem('teacher_key');
    return r;
  } catch (err) {
    console.error(err);
    return { ok: false, error: 'No hay conexión con Google Apps Script (revisa la URL y el acceso "Cualquier persona").' };
  }
}

// ---- Cola de entregas pendientes (se guardan en el dispositivo hasta confirmarse) ----
function getPending() {
  return readJSON('pending_results', []);
}

function setPending(list) {
  localStorage.setItem('pending_results', JSON.stringify(list));
}

async function doSendPending() {
  let sent = 0;
  for (const rec of getPending()) {
    try {
      const r = await apiPost({ action: 'submitResult', record: rec });
      if (r && r.ok) {
        setPending(getPending().filter(p => p.id !== rec.id));
        sent++;
      } else {
        console.error('El servidor rechazó la entrega:', r);
      }
    } catch (err) {
      console.error('Error enviando entrega:', err);
      break; // sin conexión: reintentar después
    }
  }
  return { sent, remaining: getPending().length };
}

// Serializa los envíos para que nunca se solapen
let sendChain = Promise.resolve();
function sendPendingResults() {
  sendChain = sendChain.then(doSendPending, doSendPending);
  return sendChain;
}

function setSyncStatus(state) {
  const el = document.getElementById('syncStatus');
  if (!el) return;

  if (state === 'sending') {
    el.style.color = '#8a6d00';
    el.innerHTML = '⏳ Enviando tus respuestas al profesor…';
  } else if (state === 'ok') {
    el.style.color = '#2e7d32';
    el.innerHTML = '✅ Tus respuestas fueron enviadas y registradas correctamente.';
  } else {
    el.style.color = '#c62828';
    el.innerHTML = '⚠️ No se pudo enviar todavía. Tu entrega quedó guardada en este dispositivo. ' +
      '<button type="button" class="btn" onclick="retrySend()">Reintentar envío</button>';
  }
}

async function retrySend() {
  setSyncStatus('sending');
  const { remaining } = await sendPendingResults();
  setSyncStatus(remaining === 0 ? 'ok' : 'error');
}

// ==========================================
// 1. ENRUTADOR Y CARGA INICIAL
// ==========================================
window.addEventListener('DOMContentLoaded', async () => {
  examsBank = readJSON('exams_bank', []);
  evaluationHistory = readJSON('evaluation_history', []);

  const urlParams = new URLSearchParams(window.location.search);
  const mode = urlParams.get('mode');
  const sharedExamId = urlParams.get('examId');

  if (mode === 'student' || sharedExamId) {
    // MÓDULO ESTUDIANTE
    showStudentModule();
    sendPendingResults();            // reintenta entregas que hayan quedado pendientes
    await loadSharedExam(sharedExamId);
  } else {
    // MÓDULO DOCENTE POR DEFECTO
    showTeacherModule();
    loadProfile();
    renderExamsBank();
    sendPendingResults();
  }
});

// El estudiante descarga el examen desde Google Sheets (no depende del equipo del profesor)
async function loadSharedExam(examId) {
  const container = document.getElementById('previewQuestionsContainer');
  if (container) container.innerHTML = '<p class="empty-text">Cargando examen…</p>';

  let exam = null;
  try {
    const r = await apiGet({ action: 'getExam', examId });
    if (r && r.ok) exam = r.exam;
  } catch (err) {
    console.error('No se pudo descargar el examen:', err);
  }

  // Respaldo: si estamos en el equipo del docente, usar la copia local
  if (!exam) exam = examsBank.find(e => String(e.id) === String(examId)) || null;

  if (!exam) {
    if (container) {
      container.innerHTML = '<p class="empty-text">No se pudo cargar el examen. Verifica el enlace o pide al profesor que lo publique de nuevo.</p>';
    }
    alert('No se pudo cargar el examen. Verifica el enlace con tu profesor.');
    return;
  }

  startStudentExam(exam, false);
}

function saveBankToStorage() {
  localStorage.setItem('exams_bank', JSON.stringify(examsBank));
}

function saveHistoryToStorage() {
  localStorage.setItem('evaluation_history', JSON.stringify(evaluationHistory));
}

// ==========================================
// 2. GESTIÓN DE PERFIL DOCENTE
// ==========================================
function updateProfile() {
  const name = document.getElementById('profNameInput')?.value || '';
  const subject = document.getElementById('profSubjectInput')?.value || '';
  const bio = document.getElementById('profBioInput')?.value || '';
  localStorage.setItem('prof_profile', JSON.stringify({ name, subject, bio }));
}

function loadProfile() {
  const p = readJSON('prof_profile', null);
  if (!p) return;
  const n = document.getElementById('profNameInput');
  const s = document.getElementById('profSubjectInput');
  const b = document.getElementById('profBioInput');
  if (n) n.value = p.name || '';
  if (s) s.value = p.subject || '';
  if (b) b.value = p.bio || '';
}

document.getElementById('avatarInput')?.addEventListener('change', function (e) {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = function (event) {
      const img = document.getElementById('avatarImage');
      if (img) img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  }
});

// ==========================================
// 3. CREACIÓN Y EDICIÓN DE EXÁMENES
// ==========================================
function openExamCreator(examId = null) {
  const section = document.getElementById('examCreatorSection');
  if (section) {
    section.classList.remove('hidden');
    section.style.display = 'block';
  }

  if (examId) {
    const exam = examsBank.find(e => e.id === examId);
    if (!exam) return;

    editingExamId = exam.id;
    document.getElementById('creatorTitle').textContent = 'Editar Examen';
    document.getElementById('examTitleInput').value = exam.title;
    document.getElementById('examTimeInput').value = exam.timeLimit;
    currentExamQuestions = JSON.parse(JSON.stringify(exam.questions));
  } else {
    editingExamId = null;
    document.getElementById('creatorTitle').textContent = 'Nuevo Examen';
    document.getElementById('examTitleInput').value = '';
    document.getElementById('examTimeInput').value = '30';
    currentExamQuestions = [];
  }

  renderCurrentExamQuestions();
}

function closeExamCreator() {
  const section = document.getElementById('examCreatorSection');
  if (section) {
    section.classList.add('hidden');
    section.style.display = 'none'; // el inline display:block anulaba la clase "hidden"
  }
  currentExamQuestions = [];
  editingExamId = null;
}

function toggleOptionFields() {
  const type = document.getElementById('newQuestionType').value;
  const optionsBlock = document.getElementById('multipleOptionsBlock');
  if (optionsBlock) {
    optionsBlock.style.display = (type === 'multiple') ? 'block' : 'none';
  }
}

function addQuestionToCurrentExam() {
  const textInput = document.getElementById('newQuestionText');
  const pointsInput = document.getElementById('newQuestionPoints');
  const text = textInput ? textInput.value.trim() : '';
  const type = document.getElementById('newQuestionType').value;
  const points = pointsInput ? parseFloat(pointsInput.value) || 1 : 1;

  if (!text) {
    alert('Ingresa el enunciado de la pregunta.');
    return;
  }

  const question = {
    id: Date.now(),
    type: type,
    text: text,
    points: points
  };

  if (type === 'multiple') {
    const optInputs = document.querySelectorAll('.opt-input');
    const options = Array.from(optInputs).map(i => i.value.trim());
    const selectedRadio = document.querySelector('input[name="correctOpt"]:checked');

    if (options.some(o => o === '')) {
      alert('Completa todas las opciones de respuesta.');
      return;
    }

    question.options = options;
    question.correctIndex = selectedRadio ? parseInt(selectedRadio.value) : 0;
  }

  currentExamQuestions.push(question);

  if (textInput) textInput.value = '';
  document.querySelectorAll('.opt-input').forEach(i => i.value = '');
  if (pointsInput) pointsInput.value = '1';

  renderCurrentExamQuestions();
}

function removeQuestionFromCurrentExam(id) {
  currentExamQuestions = currentExamQuestions.filter(q => q.id !== id);
  renderCurrentExamQuestions();
}

function renderCurrentExamQuestions() {
  const container = document.getElementById('currentExamQuestionsList');
  if (!container) return;
  container.innerHTML = '';

  if (currentExamQuestions.length === 0) {
    container.innerHTML = '<p class="empty-text">Aún no hay preguntas agregadas.</p>';
    return;
  }

  currentExamQuestions.forEach((q, index) => {
    const div = document.createElement('div');
    div.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #eee;';
    div.innerHTML = `
      <div>
        <strong>${index + 1}. ${escapeHtml(q.text)}</strong>
        <small style="color: #666;">(${q.type === 'multiple' ? 'Opción múltiple' : 'Abierta'} - ${q.points} pts)</small>
      </div>
      <button class="btn btn-danger-sm" onclick="removeQuestionFromCurrentExam(${q.id})">Eliminar</button>
    `;
    container.appendChild(div);
  });
}

async function saveExamToBank() {
  const titleInput = document.getElementById('examTitleInput');
  const timeInput = document.getElementById('examTimeInput');
  const title = titleInput ? titleInput.value.trim() : '';
  const timeLimit = timeInput ? parseInt(timeInput.value) || 30 : 30;

  if (!title) {
    alert('Asigna un título al examen.');
    return;
  }

  if (currentExamQuestions.length === 0) {
    alert('Agrega al menos una pregunta antes de guardar.');
    return;
  }

  const questions = JSON.parse(JSON.stringify(currentExamQuestions));
  let exam;

  if (editingExamId) {
    exam = { id: editingExamId, title, timeLimit, questions };
    const index = examsBank.findIndex(e => e.id === editingExamId);
    if (index !== -1) examsBank[index] = exam;
    else examsBank.push(exam);
  } else {
    exam = { id: Date.now(), title, timeLimit, questions };
    examsBank.push(exam);
  }

  saveBankToStorage();
  closeExamCreator();
  renderExamsBank();

  // Publicar en Google Sheets para que los estudiantes puedan abrirlo desde cualquier dispositivo
  const r = await publishExamToSheets(exam);
  if (r.ok) {
    alert('✅ Examen guardado y publicado en la nube.');
  } else {
    alert('⚠️ El examen se guardó en este equipo, pero NO se publicó:\n' + (r.error || 'error desconocido') +
      '\n\nUsa el botón "Publicar y copiar link" para reintentarlo.');
  }
}

async function deleteExamFromBank(id) {
  if (!confirm('¿Deseas eliminar este examen del banco? También dejará de estar disponible el link de los estudiantes.')) return;

  examsBank = examsBank.filter(e => e.id !== id);
  saveBankToStorage();
  renderExamsBank();

  const key = getTeacherKey();
  if (!key) return;
  try {
    const r = await apiPost({ action: 'deleteExam', key, examId: id });
    if (!r.ok) {
      if (/clave/i.test(r.error || '')) localStorage.removeItem('teacher_key');
      alert('El examen se borró de este equipo, pero no de la nube: ' + r.error);
    }
  } catch (err) {
    alert('El examen se borró de este equipo, pero no se pudo contactar con la nube.');
  }
}

function renderExamsBank() {
  const container = document.getElementById('examsBankContainer');
  if (!container) return;
  container.innerHTML = '';

  if (examsBank.length === 0) {
    container.innerHTML = '<p class="empty-text">No hay exámenes en el banco.</p>';
    return;
  }

  examsBank.forEach((exam) => {
    const card = document.createElement('div');
    card.style.cssText = 'background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin-bottom: 12px;';

    const submissionCount = evaluationHistory.filter(h => h.examId === exam.id).length;

    card.innerHTML = `
      <h3>${escapeHtml(exam.title)}</h3>
      <p style="font-size:0.85rem; color: #666; margin: 6px 0 12px;">
        ⏱️ ${exam.timeLimit} min | ❓ ${exam.questions.length} preguntas | 📝 Pruebas hechas en este equipo: <strong>${submissionCount}</strong>
      </p>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <button class="btn" onclick="previewExam(${exam.id})">Probar Examen</button>
        <button class="btn btn-secondary" onclick="openExamCreator(${exam.id})">Editar</button>
        <button class="btn btn-secondary" onclick="shareExam(${exam.id})">🔗 Publicar y copiar link</button>
        <button class="btn btn-danger-sm" onclick="deleteExamFromBank(${exam.id})">Eliminar</button>
      </div>
    `;

    container.appendChild(card);
  });
}

// Publica el examen (para asegurar que está en la nube) y copia el enlace del estudiante
async function shareExam(examId) {
  const exam = examsBank.find(e => e.id === examId);
  if (!exam) return;

  if (window.location.protocol === 'file:') {
    alert('Para compartir el enlace, esta página debe estar alojada en internet (GitHub Pages, Netlify, etc.). Abierta como archivo local no funcionará para los estudiantes.');
    return;
  }

  const r = await publishExamToSheets(exam);
  if (!r.ok) {
    alert('No se pudo publicar el examen:\n' + (r.error || 'error desconocido'));
    return;
  }

  const url = `${window.location.origin}${window.location.pathname}?mode=student&examId=${exam.id}`;
  copyShareLink(url);
}

function copyShareLink(url) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(() => {
      alert('✅ Examen publicado. ¡Enlace para estudiantes copiado!');
    }).catch(() => prompt('Copia este enlace para enviarlo a los estudiantes:', url));
  } else {
    prompt('Copia este enlace para enviarlo a los estudiantes:', url);
  }
}

// ==========================================
// 4. MÓDULO ESTUDIANTE: PRESENTACIÓN Y CONTROL
// ==========================================
function previewExam(examId) {
  const exam = examsBank.find(e => e.id === examId);
  if (!exam) return;

  showStudentModule();
  startStudentExam(exam, true);
}

function exitPreview() {
  clearInterval(timerInterval);
  deactivateExamProtection();
  activeExamForPreview = null;
  showTeacherModule();
}

function startStudentExam(exam, preview = false) {
  isPreviewMode = preview;

  const nameInput = prompt(`Bienvenido/a a la evaluación: "${exam.title}"\n\nIngresa tu nombre completo para comenzar:`);

  if (!nameInput || nameInput.trim() === '') {
    alert('El nombre es obligatorio.');
    if (preview) {
      exitPreview();
      return;
    }
    // Estudiante: mostrar botón para reintentar (no lo sacamos al módulo docente)
    pendingExam = exam;
    const container = document.getElementById('previewQuestionsContainer');
    if (container) {
      container.innerHTML = `
        <div style="text-align:center; padding:24px;">
          <p>Necesitas ingresar tu nombre para comenzar la evaluación.</p>
          <button type="button" class="btn" onclick="startStudentExam(pendingExam, false)">Comenzar evaluación</button>
        </div>`;
    }
    return;
  }

  studentName = nameInput.trim();
  exitAttemptsCount = 0;
  activeExamForPreview = exam;

  // Restablecer pantallas (por si ya se había presentado un examen antes)
  const previewSection = document.getElementById('previewSection');
  const resultsContainer = document.getElementById('resultsContainer');
  if (previewSection) previewSection.style.display = 'block';
  if (resultsContainer) resultsContainer.classList.add('hidden');

  document.getElementById('previewTitle').textContent =
    `Evaluación: ${exam.title} — Estudiante: ${studentName}${preview ? ' (modo prueba)' : ''}`;

  renderPreviewQuestions(exam);
  startTimer(exam.timeLimit);
  activateExamProtection();
}

// Cuenta regresiva basada en la hora real (no se descuadra si la pestaña se pone en segundo plano)
function startTimer(timeLimitMin) {
  clearInterval(timerInterval);
  examStartTs = Date.now();
  secondsElapsed = 0;

  const limitSeconds = (parseInt(timeLimitMin, 10) || 0) * 60;
  const display = document.getElementById('previewTimerDisplay');

  const tick = () => {
    secondsElapsed = Math.floor((Date.now() - examStartTs) / 1000);
    const shown = limitSeconds > 0 ? Math.max(limitSeconds - secondsElapsed, 0) : secondsElapsed;
    const mins = String(Math.floor(shown / 60)).padStart(2, '0');
    const secs = String(shown % 60).padStart(2, '0');
    if (display) {
      display.textContent = (limitSeconds > 0 ? '⏳ Tiempo restante: ' : '⏱️ ') + `${mins}:${secs}`;
    }

    if (limitSeconds > 0 && secondsElapsed >= limitSeconds) {
      clearInterval(timerInterval);
      finishExam(true); // se agotó el tiempo: entrega automática
    }
  };

  tick();
  timerInterval = setInterval(tick, 1000);
}

function activateExamProtection() {
  window.onbeforeunload = function () {
    if (activeExamForPreview) {
      return '⚠️ Salir o recargar afectará tu nota.';
    }
  };

  document.removeEventListener('visibilitychange', handleVisibilityChange);
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

function handleVisibilityChange() {
  if (document.hidden && activeExamForPreview) {
    exitAttemptsCount++;
    alert(`⚠️ ¡ATENCIÓN ${studentName}! Salir de la pestaña queda registrado (${exitAttemptsCount} veces).`);
  }
}

function deactivateExamProtection() {
  window.onbeforeunload = null;
  document.removeEventListener('visibilitychange', handleVisibilityChange);
}

function renderPreviewQuestions(exam) {
  const container = document.getElementById('previewQuestionsContainer');
  if (!container) return;
  container.innerHTML = '';

  exam.questions.forEach((q, index) => {
    const qDiv = document.createElement('div');
    qDiv.style.cssText = 'background: #f9f9f9; border: 1px solid #ddd; padding: 14px; border-radius: 8px; margin-bottom: 14px;';

    let content = `
      <div style="font-weight:600; margin-bottom: 8px; display: flex; justify-content: space-between;">
        <span>${index + 1}. ${escapeHtml(q.text)}</span>
        <span style="color: #666; font-size: 0.85rem;">[${q.points || 1} pts]</span>
      </div>`;

    if (q.type === 'multiple') {
      content += `<div style="display:flex; flex-direction:column; gap:6px;">`;
      q.options.forEach((opt, optIndex) => {
        content += `
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="radio" name="preview_question_${q.id}" value="${optIndex}" required>
            ${escapeHtml(opt)}
          </label>
        `;
      });
      content += `</div>`;
    } else {
      content += `
        <textarea name="preview_question_${q.id}" rows="3" placeholder="Escribe tu respuesta..." style="width:100%; padding:8px; box-sizing:border-box;" required></textarea>
      `;
    }

    qDiv.innerHTML = content;
    container.appendChild(qDiv);
  });
}

// ==========================================
// 5. EVALUACIÓN Y ENVÍO DE RESPUESTAS (GOOGLE SHEETS + RESPALDO LOCAL)
// ==========================================
document.getElementById('previewExamForm')?.addEventListener('submit', function (e) {
  e.preventDefault();
  finishExam(false);
});

function finishExam(auto = false) {
  const exam = activeExamForPreview;
  if (!exam) return; // evita doble entrega (clic + tiempo agotado)
  activeExamForPreview = null;

  clearInterval(timerInterval);
  deactivateExamProtection();

  const mins = Math.floor(secondsElapsed / 60);
  const secs = secondsElapsed % 60;
  const timeTakenStr = `${mins}m ${secs}s`;

  let totalScoreEarned = 0;
  let maxPossibleScore = 0;
  let correctCount = 0;
  let totalMultipleCount = 0;
  const responsesLog = [];

  exam.questions.forEach((q) => {
    const points = q.points || 1;
    maxPossibleScore += points;

    if (q.type === 'multiple') {
      totalMultipleCount++;
      const selected = document.querySelector(`[name="preview_question_${q.id}"]:checked`);
      const selectedIndex = selected ? parseInt(selected.value) : -1;
      const isCorrect = selectedIndex === q.correctIndex;

      if (isCorrect) {
        correctCount++;
        totalScoreEarned += points;
      }

      responsesLog.push({
        pregunta: q.text,
        tipo: 'Opción Múltiple',
        puntosPosibles: points,
        puntosObtenidos: isCorrect ? points : 0,
        respuestaDada: selectedIndex !== -1 ? q.options[selectedIndex] : 'Sin responder',
        estado: isCorrect ? 'Correcta' : 'Incorrecta',
        opcionCorrecta: q.options[q.correctIndex]
      });
    } else {
      const openText = document.querySelector(`[name="preview_question_${q.id}"]`)?.value || '';
      responsesLog.push({
        pregunta: q.text,
        tipo: 'Abierta',
        puntosPosibles: points,
        puntosObtenidos: 'Pendiente',
        respuestaDada: openText,
        estado: 'Pendiente de revisión',
        opcionCorrecta: 'N/A'
      });
    }
  });

  const finalGrade = maxPossibleScore > 0
    ? ((totalScoreEarned / maxPossibleScore) * 5.0).toFixed(2)
    : '0.00';

  const now = new Date();
  const resultRecord = {
    id: Date.now(),
    examId: exam.id,
    estudiante: studentName,
    examenTitle: exam.title,
    fecha: now.toLocaleString('es-CO'),
    fechaISO: now.toISOString(),
    tiempoEmpleado: timeTakenStr,
    respuestasCorrectas: `${correctCount} de ${totalMultipleCount}`,
    puntuacionTotal: `${totalScoreEarned.toFixed(1)} / ${maxPossibleScore.toFixed(1)}`,
    puntosObtenidos: totalScoreEarned,
    puntosPosibles: maxPossibleScore,
    notaFinal: finalGrade,
    notaNumero: Number(finalGrade),
    intentosSalida: exitAttemptsCount,
    esPrueba: isPreviewMode,
    entrega: auto ? 'Automática (tiempo agotado)' : 'Manual',
    detalles: responsesLog
  };

  // 1) Respaldo local en este dispositivo
  evaluationHistory.push(resultRecord);
  saveHistoryToStorage();

  // 2) Cola de envío: se guarda antes de enviar para no perder la entrega si falla la red
  setPending([...getPending(), resultRecord]);

  // 3) Pantalla de resultado
  const scoreDetails = document.getElementById('scoreDetails');
  scoreDetails.innerHTML = `
    <div style="background: #e8f5e9; padding: 20px; border-radius: 8px; border: 1px solid #4CAF50; text-align: center;">
      <h2 style="color: #4CAF50;">✅ ¡Evaluación finalizada!</h2>
      ${auto ? '<p>⏰ Se agotó el tiempo y tu evaluación se entregó automáticamente.</p>' : ''}
      <p id="syncStatus" style="font-weight: 600;"></p>
      <div style="background: #fff; padding: 15px; border-radius: 8px; border: 1px solid #ddd; margin-top: 15px; text-align: left;">
        <p>👤 <strong>Estudiante:</strong> ${escapeHtml(studentName)}</p>
        <p>⏱️ <strong>Tiempo empleado:</strong> ${timeTakenStr}</p>
        <p>🏆 <strong>Puntuación:</strong> ${totalScoreEarned.toFixed(1)} / ${maxPossibleScore.toFixed(1)} pts</p>
        <p style="font-size: 1.2rem; margin-top: 6px;">📊 <strong>Nota estimada:</strong> <strong>${finalGrade} / 5.0</strong></p>
        <p style="font-size: 0.8rem; color: #666;">Las preguntas abiertas quedan pendientes de revisión por el profesor.</p>
      </div>
    </div>
  `;

  const previewSection = document.getElementById('previewSection');
  const resultsContainer = document.getElementById('resultsContainer');
  if (previewSection) previewSection.style.display = 'none';
  if (resultsContainer) {
    resultsContainer.classList.remove('hidden');
    resultsContainer.style.display = 'block';
  }

  // 4) Envío a Google Sheets
  retrySend();
}

// ==========================================
// 6. EXPORTACIÓN GENERAL A EXCEL (historial local)
// ==========================================
function exportToExcel() {
  if (typeof XLSX === 'undefined') {
    alert('No se cargó la librería XLSX. Revisa que el <script> de SheetJS esté en tu HTML.');
    return;
  }

  if (evaluationHistory.length === 0) {
    alert('No hay respuestas registradas para exportar.');
    return;
  }

  const rows = [];

  evaluationHistory.forEach(record => {
    record.detalles.forEach((item, index) => {
      rows.push({
        'Estudiante': record.estudiante,
        'Examen': record.examenTitle,
        'Fecha / Hora': record.fecha,
        '# Pregunta': index + 1,
        'Pregunta': item.pregunta,
        'Tipo': item.tipo,
        'Respuesta Estudiante': item.respuestaDada,
        'Estado': item.estado,
        'Puntos Obtenidos': item.puntosObtenidos,
        'Puntos Posibles': item.puntosPosibles,
        'Opción Correcta': item.opcionCorrecta,
        'Nota Final (0-5)': record.notaFinal,
        'Intentos de Salida': record.intentosSalida,
        'Tiempo Empleado': record.tiempoEmpleado
      });
    });
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Resultados');

  XLSX.writeFile(workbook, 'Reporte_Evaluaciones.xlsx');
}
