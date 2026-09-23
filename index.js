// ==========================================
// ESTADO GLOBAL DE LA APLICACIÓN
// ==========================================
let examsBank = [];              // Banco de exámenes
let currentExamQuestions = [];   // Preguntas del examen en edición
let editingExamId = null;        // ID de examen en edición
let activeExamForPreview = null; // Examen activo
let evaluationHistory = [];      // Historial global de intentos locales

// Control de presentación
let studentName = '';
let exitAttemptsCount = 0;
let secondsElapsed = 0;
let timerInterval = null;

// ==========================================
// 1. ENRUTADOR Y CARGA INICIAL (MODIFICADO PARA LINKS UNIVERSALES)
// ==========================================
window.addEventListener('DOMContentLoaded', () => {
  // Cargar datos locales (solo para el profesor)
  const savedExams = localStorage.getItem('exams_bank');
  if (savedExams) {
    try { examsBank = JSON.parse(savedExams); } catch (e) {}
  }

  const savedHistory = localStorage.getItem('evaluation_history');
  if (savedHistory) {
    try { evaluationHistory = JSON.parse(savedHistory); } catch (e) {}
  }

  // Detección de parámetros URL
  const urlParams = new URLSearchParams(window.location.search);
  const mode = urlParams.get('mode');
  const sharedExamId = urlParams.get('examId');
  const encodedExamData = urlParams.get('examData'); // Lee el examen incrustado en el link

  const teacherMod = document.getElementById('teacherModule');
  const studentMod = document.getElementById('studentModule');

  // MÓDULO ESTUDIANTE
  if (mode === 'student' || sharedExamId || encodedExamData) {
    if (teacherMod) teacherMod.style.display = 'none';
    if (studentMod) {
      studentMod.classList.remove('hidden');
      studentMod.style.display = 'block';
    }

    let targetExam = null;

    // 1. Intentar cargar el examen directamente desde el enlace (celular del estudiante)
    if (encodedExamData) {
      try {
        const decodedStr = decodeURIComponent(escape(atob(decodeURIComponent(encodedExamData))));
        targetExam = JSON.parse(decodedStr);
      } catch (e) {
        console.error("Error al decodificar examen:", e);
        alert('El enlace del examen es inválido o está incompleto.');
      }
    } 
    // 2. Si no hay link largo, intentar cargar localmente (PC del profesor)
    else if (sharedExamId) {
      targetExam = examsBank.find(e => e.id === parseInt(sharedExamId));
    }

    if (targetExam) {
      setTimeout(() => startStudentExam(targetExam), 200);
    } else {
      alert('El examen solicitado no se pudo cargar. Pide al profesor un nuevo enlace.');
    }
  } else {
    // MÓDULO DOCENTE POR DEFECTO
    if (studentMod) studentMod.style.display = 'none';
    if (teacherMod) {
      teacherMod.classList.remove('hidden');
      teacherMod.style.display = 'block';
    }
    renderExamsBank();
  }
});

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
  if (section) section.classList.add('hidden');
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
        <strong>${index + 1}. ${q.text}</strong> 
        <small style="color: #666;">(${q.type === 'multiple' ? 'Opción múltiple' : 'Abierta'} - ${q.points} pts)</small>
      </div>
      <button class="btn btn-danger-sm" onclick="removeQuestionFromCurrentExam(${q.id})">Eliminar</button>
    `;
    container.appendChild(div);
  });
}

function saveExamToBank() {
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

  if (editingExamId) {
    const index = examsBank.findIndex(e => e.id === editingExamId);
    if (index !== -1) {
      examsBank[index] = { id: editingExamId, title, timeLimit, questions: [...currentExamQuestions] };
    }
  } else {
    examsBank.push({ id: Date.now(), title, timeLimit, questions: [...currentExamQuestions] });
  }

  saveBankToStorage();
  closeExamCreator();
  renderExamsBank();
}

function deleteExamFromBank(id) {
  if (confirm('¿Deseas eliminar este examen del banco?')) {
    examsBank = examsBank.filter(e => e.id !== id);
    saveBankToStorage();
    renderExamsBank();
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

    // MODIFICADO: Generación del enlace empaquetando el examen completo en la URL
    const examJson = JSON.stringify(exam);
    const encodedExam = encodeURIComponent(btoa(unescape(encodeURIComponent(examJson))));
    
    // Creamos la URL base limpia y le pegamos los datos
    const baseUrl = window.location.origin + window.location.pathname;
    const studentShareUrl = `${baseUrl}?mode=student&examData=${encodedExam}`;

    const submissionCount = evaluationHistory.filter(h => h.examId === exam.id).length;

    card.innerHTML = `
      <h3>${exam.title}</h3>
      <p style="font-size:0.85rem; color: #666; margin: 6px 0 12px;">
        ⏱️ ${exam.timeLimit} min | ❓ ${exam.questions.length} preguntas | 📝 Entregas locales: <strong>${submissionCount}</strong>
      </p>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <button class="btn" onclick="previewExam(${exam.id})">Probar Examen</button>
        <button class="btn btn-secondary" onclick="openExamCreator(${exam.id})">Editar</button>
        <button class="btn btn-secondary" onclick="copyShareLink('${studentShareUrl}')">🔗 Copiar Link Estudiante</button>
        <button class="btn btn-danger-sm" onclick="deleteExamFromBank(${exam.id})">Eliminar</button>
      </div>
    `;

    container.appendChild(card);
  });
}

function copyShareLink(url) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(() => {
      alert('¡Enlace exclusivo para estudiantes copiado! Envíalo por WhatsApp o correo.');
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
  
  document.getElementById('teacherModule').style.display = 'none';
  const studentMod = document.getElementById('studentModule');
  studentMod.classList.remove('hidden');
  studentMod.style.display = 'block';

  startStudentExam(exam);
}

function startStudentExam(exam) {
  const nameInput = prompt(`Bienvenido/a a la evaluación: "${exam.title}"\n\nIngresa tu nombre completo para comenzar:`);
  
  if (!nameInput || nameInput.trim() === '') {
    alert('El nombre es obligatorio.');
    if (window.location.search.includes('examData') || window.location.search.includes('examId')) {
      window.location.href = window.location.pathname;
    }
    return;
  }

  studentName = nameInput.trim();
  exitAttemptsCount = 0;
  activeExamForPreview = exam;

  document.getElementById('previewTitle').textContent = `Evaluación: ${exam.title} — Estudiante: ${studentName}`;
  
  renderPreviewQuestions(exam);
  startTimer();
  activateExamProtection();
}

function startTimer() {
  clearInterval(timerInterval);
  secondsElapsed = 0;
  
  timerInterval = setInterval(() => {
    secondsElapsed++;
    const mins = String(Math.floor(secondsElapsed / 60)).padStart(2, '0');
    const secs = String(secondsElapsed % 60).padStart(2, '0');
    const display = document.getElementById('previewTimerDisplay');
    if (display) display.textContent = `⏱️ ${mins}:${secs}`;
  }, 1000);
}

function activateExamProtection() {
  window.onbeforeunload = function () {
    if (activeExamForPreview) {
      return "⚠️ Salir o recargar afectará tu nota.";
    }
  };
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

function handleVisibilityChange() {
  if (document.hidden && activeExamForPreview) {
    exitAttemptsCount++;
    alert(`⚠️ ¡ATENCIÓN ${studentName}! Salir de la pestaña o cambiar de aplicación queda registrado (${exitAttemptsCount} veces).`);
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
        <span>${index + 1}. ${q.text}</span>
        <span style="color: #666; font-size: 0.85rem;">[${q.points || 1} pts]</span>
      </div>`;

    if (q.type === 'multiple') {
      content += `<div style="display:flex; flex-direction:column; gap:6px;">`;
      q.options.forEach((opt, optIndex) => {
        content += `
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="radio" name="preview_question_${q.id}" value="${optIndex}" required>
            ${opt}
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
// 5. EVALUACIÓN Y GUARDADO DE RESPUESTAS (MODIFICADO PARA GOOGLE SHEETS)
// ==========================================
document.getElementById('previewExamForm')?.addEventListener('submit', function (e) {
  e.preventDefault();
  if (!activeExamForPreview) return;

  clearInterval(timerInterval);
  deactivateExamProtection();

  const mins = Math.floor(secondsElapsed / 60);
  const secs = secondsElapsed % 60;
  const timeTakenStr = `${mins}m ${secs}s`;

  let totalScoreEarned = 0;
  let maxPossibleScore = 0;
  let correctCount = 0;
  let totalMultipleCount = 0;
  let responsesLog = [];

  activeExamForPreview.questions.forEach((q) => {
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
    }
  });

  const finalGrade = maxPossibleScore > 0 ? ((totalScoreEarned / maxPossibleScore) * 5.0).toFixed(2) : '0.00';

  const resultRecord = {
    estudiante: studentName,
    examenTitle: activeExamForPreview.title,
    fecha: new Date().toLocaleString(),
    tiempoEmpleado: timeTakenStr,
    puntuacionTotal: `${totalScoreEarned.toFixed(1)} / ${maxPossibleScore.toFixed(1)}`,
    notaFinal: finalGrade,
    intentosSalida: exitAttemptsCount
  };

  // Mostrar pantalla de carga para evitar doble envío
  const scoreDetails = document.getElementById('scoreDetails');
  scoreDetails.innerHTML = `
    <div style="text-align: center; padding: 20px;">
      <h3>Enviando resultados de forma segura... ⏳</h3>
      <p style="color: #666;">Por favor no cierres esta ventana.</p>
    </div>
  `;
  document.getElementById('previewSection').style.display = 'none';
  document.getElementById('resultsContainer').classList.remove('hidden');

  // ==============================================================
  // ⚠️ ATENCIÓN: PEGA AQUÍ LA URL QUE TE DIO GOOGLE APPS SCRIPT
  // ==============================================================
  const scriptURL = 'https://script.google.com/macros/s/AKfycbzaWbqOxg35ZZXduBvGkqchSYLOMAaX2xnQkp93rur-0Kw3Mp9rFtdJ392-LX9A835T/exec'; 

  // Enviar datos de forma invisible a Google Sheets
  fetch(scriptURL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(resultRecord)
  })
  .then(response => {
    scoreDetails.innerHTML = `
      <div style="background: #e8f5e9; padding: 20px; border-radius: 8px; border: 1px solid #4CAF50; text-align: center;">
        <h2 style="color: #4CAF50;">✅ ¡Evaluación Entregada con Éxito!</h2>
        <p>Tus respuestas y tu tiempo han sido registrados de forma segura en el sistema del profesor.</p>
        <p style="font-size: 0.9rem; color: #555; margin-top: 10px;">Ya puedes cerrar esta pestaña.</p>
      </div>
    `;
  })
  .catch(error => {
    console.error('Error:', error);
    scoreDetails.innerHTML = `
      <div style="background: #ffebee; padding: 20px; border-radius: 8px; border: 1px solid #f44336; text-align: center;">
        <h2 style="color: #f44336;">❌ Error de conexión</h2>
        <p>Hubo un problema al enviar tu examen a la base de datos del profesor.</p>
        <p style="margin-top:10px;">Por favor, toma una captura de pantalla de esta información y envíala a tu profesor:</p>
        <div style="background: #fff; padding: 10px; margin-top: 10px; border: 1px solid #ddd; text-align: left;">
            <p><strong>Estudiante:</strong> ${studentName}</p>
            <p><strong>Nota Local Estimada:</strong> ${finalGrade} / 5.0</p>
            <p><strong>Tiempo:</strong> ${timeTakenStr}</p>
        </div>
      </div>
    `;
  });
  
  activeExamForPreview = null;
});

// ==========================================
// 6. EXPORTACIÓN LOCAL A EXCEL (MODIFICADO POR EVALUACIÓN)
// ==========================================
// NOTA: Esta función ahora sirve solo como respaldo para pruebas hechas en la PC del profe.
// Las notas de los estudiantes llegarán directo a tu Google Sheets.
function exportToExcel() {
  if (evaluationHistory.length === 0) {
    alert('No hay respuestas locales registradas para exportar.');
    return;
  }

  const rows = evaluationHistory.map(record => {
    return {
      'Estudiante': record.estudiante,
      'Examen': record.examenTitle,
      'Fecha / Hora': record.fecha,
      'Nota Final (0-5)': record.notaFinal,
      'Puntos Obtenidos': record.puntuacionTotal,
      'Intentos de Salida (Trampa)': record.intentosSalida,
      'Tiempo Empleado': record.tiempoEmpleado
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Resultados Locales');

  XLSX.writeFile(workbook, 'Reporte_Evaluaciones_Local.xlsx');
}