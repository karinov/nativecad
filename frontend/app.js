// OptiPrime NativeCAD AI Studio Client Logic
const API_BASE = "/nativecad/api";

// State
let token = localStorage.getItem("nativecad_token") || "";
let activeColorIndex = 0;
const CAD_COLORS = [0x7089ba, 0x8da4d0, 0x10b981, 0xe2e8f0, 0xf59e0b];
let chatHistory = [];
let lastPrompt = "";

// Three.js State
let scene, camera, renderer, controls, currentMesh, gridHelper;
let isWireframe = false;
let isGridVisible = true;

// DOM Elements
const loginModal = document.getElementById("login-modal");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const btnLogout = document.getElementById("btn-logout");
const statusBadge = document.getElementById("status-badge");
const statusText = document.getElementById("status-text");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const btnSend = document.getElementById("btn-send");
const assetsGrid = document.getElementById("assets-grid");
const assetCount = document.getElementById("asset-count");

// View containers
const view3dContainer = document.getElementById("view-3d-container");
const viewAssetsContainer = document.getElementById("view-assets-container");
const canvasControls = document.getElementById("canvas-controls");
const viewportEmpty = document.getElementById("viewport-empty");
const viewportInfo = document.getElementById("viewport-info");

// Tabs
const tab3d = document.getElementById("tab-3d");
const tabAssets = document.getElementById("tab-assets");

// --- Initialization ---
document.addEventListener("DOMContentLoaded", () => {
  initThreeJS();
  checkAuth();
  setupEventListeners();
  initCardTilt();
});

// --- Authentication ---
async function checkAuth() {
  if (!token) {
    showLogin();
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (res.ok) {
      hideLogin();
      fetchStatus();
      loadAssets();
    } else {
      showLogin();
    }
  } catch (err) {
    showLogin();
  }
}

function showLogin() {
  loginModal.style.display = "flex";
}

function hideLogin() {
  loginModal.style.display = "none";
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.style.display = "none";
  const u = document.getElementById("login-username").value.trim();
  const p = document.getElementById("login-password").value.trim();

  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p })
    });
    const data = await res.json();
    if (res.ok && data.access_token) {
      token = data.access_token;
      localStorage.setItem("nativecad_token", token);
      hideLogin();
      fetchStatus();
      loadAssets();
    } else {
      loginError.textContent = data.detail || "Authentication failed. Please verify your credentials.";
      loginError.style.display = "block";
    }
  } catch (err) {
    loginError.textContent = "Backend connection failed: " + err.message;
    loginError.style.display = "block";
  }
});

btnLogout.addEventListener("click", () => {
  token = "";
  localStorage.setItem("nativecad_token", "");
  showLogin();
});

// --- Status Polling ---
async function fetchStatus() {
  try {
    const res = await fetch(`${API_BASE}/status`);
    if (res.ok) {
      const data = await res.json();
      if (data.mcp && data.mcp.connected) {
        statusBadge.className = "status-chip online";
        statusText.textContent = `CAD Studio Online • ${data.mcp.tool_count} Tools`;
      } else {
        statusBadge.className = "status-chip";
        statusText.textContent = "MCP Kernel Offline";
      }
    }
  } catch (err) {
    statusBadge.className = "status-chip";
    statusText.textContent = "CAD Engine Offline";
  }
}

// --- Event Listeners ---
function setupEventListeners() {
  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
  });

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitMessage();
    }
  });

  btnSend.addEventListener("click", () => submitMessage());

  // Quick prompt chips
  document.querySelectorAll(".prompt-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      chatInput.value = chip.dataset.prompt;
      chatInput.focus();
    });
  });

  // Tabs
  tab3d.addEventListener("click", () => switchTab("3d"));
  tabAssets.addEventListener("click", () => switchTab("assets"));

  document.getElementById("btn-refresh-assets").addEventListener("click", loadAssets);

  // 3D Toolbar
  document.getElementById("btn-fit").addEventListener("click", resetCamera);
  document.getElementById("btn-wireframe").addEventListener("click", toggleWireframe);
  document.getElementById("btn-grid").addEventListener("click", toggleGrid);
  document.getElementById("btn-color").addEventListener("click", cycleColor);

  // Mobile View Switcher
  initMobileSwitcher();
}

function initMobileSwitcher() {
  const switcher = document.getElementById("mobile-switcher");
  if (!switcher) return;
  const tabs = switcher.querySelectorAll(".mobile-switcher-tab");
  tabs.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetTab = btn.getAttribute("data-tab");
      tabs.forEach(t => t.classList.remove("active"));
      btn.classList.add("active");

      const chatPanel = document.querySelector(".chat-panel");
      const previewPanel = document.querySelector(".preview-panel");
      if (chatPanel && previewPanel) {
        if (targetTab === "chat") {
          chatPanel.classList.add("mobile-active");
          previewPanel.classList.remove("mobile-active");
        } else {
          chatPanel.classList.remove("mobile-active");
          previewPanel.classList.add("mobile-active");
          if (tab3d) switchTab("3d");
          if (renderer) {
            setTimeout(onWindowResize, 60);
          }
        }
      }
    });
  });
}

function switchToPreviewOnMobile() {
  const switcher = document.getElementById("mobile-switcher");
  if (!switcher || window.innerWidth > 860) return;
  const previewTab = switcher.querySelector('[data-tab="preview"]');
  if (previewTab && !previewTab.classList.contains("active")) {
    previewTab.click();
  }
}

function switchTab(mode) {
  [tab3d, tabAssets].forEach(t => t.classList.remove("active"));
  view3dContainer.style.display = "none";
  viewAssetsContainer.classList.remove("active");
  canvasControls.style.display = "none";

  if (mode === "3d") {
    tab3d.classList.add("active");
    view3dContainer.style.display = "block";
    canvasControls.style.display = "flex";
    if (renderer) onWindowResize();
  } else if (mode === "assets") {
    tabAssets.classList.add("active");
    viewAssetsContainer.classList.add("active");
    loadAssets();
  }
}

// --- SSE Webchat Stream with Auto-Retry & History ---
function submitMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;

  lastPrompt = msg;
  chatInput.value = "";
  chatInput.style.height = "auto";

  // Append user message to UI and history
  appendUserMessage(msg);
  chatHistory.push({ role: "user", content: msg });

  executeStream(msg);
}

window.retryLastPrompt = function() {
  if (!lastPrompt) return;
  const errBox = document.querySelector(".network-error-card");
  if (errBox) errBox.remove();
  executeStream(lastPrompt);
};

window.restorePromptToInput = function() {
  if (lastPrompt) {
    chatInput.value = lastPrompt;
    chatInput.focus();
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
  }
};

async function executeStream(promptText) {
  btnSend.disabled = true;

  // Create streaming assistant bubble
  const { wrapper, liveStatusEl, textEl, toolListEl } = createStreamContainer();
  let receivedDone = false;
  let fullResponseText = "";

  try {
    const response = await fetch(`${API_BASE}/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        message: promptText,
        history: chatHistory.slice(0, -1) // send previous context
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.detail || `HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop();

      for (const part of parts) {
        if (!part.trim()) continue;
        const lines = part.split("\n");
        let eventType = "message";
        let dataStr = "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventType = line.substring(6).trim();
          } else if (line.startsWith("data:")) {
            dataStr = line.substring(5).trim();
          }
        }

        if (eventType === "ping") {
          continue;
        }

        if (dataStr) {
          try {
            const data = JSON.parse(dataStr);
            if (eventType === "text") {
              fullResponseText = data.content || "";
            } else if (eventType === "done") {
              receivedDone = true;
              if (data.response) fullResponseText = data.response;
            }
            handleSSEEvent(eventType, data, liveStatusEl, textEl, toolListEl);
          } catch (e) {
            console.error("JSON parse error on SSE:", e, dataStr);
          }
        }
      }
    }

    liveStatusEl.style.display = "none";
    if (fullResponseText) {
      chatHistory.push({ role: "assistant", content: fullResponseText });
    }
    loadAssets();

  } catch (err) {
    console.warn("Stream interrupted:", err);
    liveStatusEl.style.display = "none";

    // Render interactive retry card so user DOES NOT need to retype prompt!
    const errCard = document.createElement("div");
    errCard.className = "network-error-card";
    errCard.style.cssText = "margin-top: 10px; padding: 12px; background: rgba(239, 68, 68, 0.08); border: 1px dashed rgba(239, 68, 68, 0.4); border-radius: 6px; font-size: 0.82rem;";
    errCard.innerHTML = `
      <div style="color: #f87171; font-weight: 600; margin-bottom: 6px; font-family: var(--font-mono);">
        ⚠️ Streaming interrupted (${escapeHtml(err.message)})
      </div>
      <div style="color: var(--color-steel); font-size: 0.76rem; margin-bottom: 10px;">
        The CAD kernel may require additional computation. You do not need to retype your prompt.
      </div>
      <div style="display: flex; gap: 8px;">
        <button onclick="retryLastPrompt()" class="btn btn-primary btn-sm">
          <span>Reconnect / Retry</span>
        </button>
        <button onclick="restorePromptToInput()" class="btn btn-secondary btn-sm">
          <span>Restore to Input</span>
        </button>
      </div>
    `;
    textEl.appendChild(errCard);

  } finally {
    btnSend.disabled = false;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

function handleSSEEvent(eventType, data, statusEl, textEl, toolListEl) {
  if (eventType === "status") {
    statusEl.innerHTML = `<span class="spinner"></span> <span>${escapeHtml(data.text || "")}</span>`;
  } else if (eventType === "tool_start") {
    const card = document.createElement("div");
    card.className = "tool-call-card";
    const argsStr = JSON.stringify(data.arguments || {});
    card.innerHTML = `
      <div class="tool-header">
        <span>⚡ ${escapeHtml(data.tool)}</span>
        <span style="font-size: 0.7rem; color: var(--color-periwinkle); font-family: var(--font-mono);">Executing...</span>
      </div>
      <div class="tool-body">${escapeHtml(argsStr)}</div>
    `;
    toolListEl.appendChild(card);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  } else if (eventType === "tool_result") {
    const cards = toolListEl.querySelectorAll(".tool-call-card");
    if (cards.length > 0) {
      const last = cards[cards.length - 1];
      const header = last.querySelector(".tool-header span:last-child");
      if (header) {
        header.textContent = "✓ Completed";
        header.style.color = "#10b981";
      }
    }
  } else if (eventType === "text") {
    textEl.innerHTML = formatMarkdown(data.content || "");
    chatMessages.scrollTop = chatMessages.scrollHeight;
  } else if (eventType === "export") {
    appendExportBadge(textEl, data);
    if (data.filename.endsWith(".stl")) {
      loadSTL(data.url, data.filename);
      switchTab("3d");
    }
  } else if (eventType === "done") {
    if (data.response && !textEl.innerHTML) {
      textEl.innerHTML = formatMarkdown(data.response);
    }
  } else if (eventType === "error") {
    statusEl.innerHTML = `<span style="color: #f87171;">⚠️ ${escapeHtml(data.message || "Error")}</span>`;
  }
}

function appendUserMessage(text) {
  const w = document.createElement("div");
  w.className = "message-wrapper user";
  w.innerHTML = `
    <div class="avatar user-avatar">U</div>
    <div class="message-bubble">${escapeHtml(text)}</div>
  `;
  chatMessages.appendChild(w);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function createStreamContainer() {
  const w = document.createElement("div");
  w.className = "message-wrapper assistant";

  const avatar = document.createElement("div");
  avatar.className = "avatar ai-avatar";
  avatar.textContent = "OP";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  const toolListEl = document.createElement("div");
  toolListEl.className = "tool-list";

  const statusEl = document.createElement("div");
  statusEl.className = "streaming-status";
  statusEl.innerHTML = `<span class="spinner"></span> <span>Synthesizing CAD geometry...</span>`;

  const textEl = document.createElement("div");
  textEl.className = "stream-text";
  textEl.style.marginTop = "8px";

  bubble.appendChild(toolListEl);
  bubble.appendChild(statusEl);
  bubble.appendChild(textEl);

  w.appendChild(avatar);
  w.appendChild(bubble);
  chatMessages.appendChild(w);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  return { wrapper: w, liveStatusEl: statusEl, textEl: textEl, toolListEl: toolListEl };
}

function appendExportBadge(container, exp) {
  const badgeBox = document.createElement("div");
  badgeBox.style.margin = "10px 0 6px";
  badgeBox.style.padding = "10px 14px";
  badgeBox.style.background = "#050505";
  badgeBox.style.border = "1px dashed rgba(16, 185, 129, 0.4)";
  badgeBox.style.borderRadius = "var(--r-nav)";
  badgeBox.style.display = "flex";
  badgeBox.style.alignItems = "center";
  badgeBox.style.justifyContent = "space-between";

  badgeBox.innerHTML = `
    <div style="display: flex; align-items: center; gap: 10px;">
      <span style="font-size: 1.1rem;">📦</span>
      <div>
        <div style="font-weight: 600; font-size: 0.85rem; color: #fff; font-family: var(--font-mono);">${escapeHtml(exp.filename)}</div>
        <div style="font-size: 0.72rem; color: var(--color-steel); font-family: var(--font-mono);">${formatBytes(exp.size)}</div>
      </div>
    </div>
    <div style="display: flex; gap: 6px;">
      <a href="${exp.url}" download class="btn btn-primary btn-sm">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 2v9M4 8l4 4 4-4M2 14h12"/>
        </svg>
        <span>Download</span>
      </a>
    </div>
  `;
  container.appendChild(badgeBox);
}

// --- Three.js 3D Viewport ---
function initThreeJS() {
  const canvas = document.getElementById("threejs-canvas");
  const container = document.getElementById("view-3d-container");

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 2000);
  camera.position.set(80, 80, 100);

  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
  scene.add(ambientLight);

  const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.85);
  dirLight1.position.set(100, 150, 100);
  scene.add(dirLight1);

  const dirLight2 = new THREE.DirectionalLight(0x7089ba, 0.45);
  dirLight2.position.set(-100, -100, -100);
  scene.add(dirLight2);

  // Technical blueprint ground grid
  gridHelper = new THREE.GridHelper(200, 20, 0x7089ba, 0x222222);
  gridHelper.position.y = -0.1;
  scene.add(gridHelper);

  // Resize listener
  window.addEventListener("resize", onWindowResize);
  const resizeObserver = new ResizeObserver(() => onWindowResize());
  resizeObserver.observe(container);

  animate();
}

function animate() {
  requestAnimationFrame(animate);
  if (controls) controls.update();
  if (renderer && scene && camera) renderer.render(scene, camera);
}

function onWindowResize() {
  const container = document.getElementById("view-3d-container");
  if (!container || !renderer || !camera) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// Load STL
function loadSTL(url, filename) {
  switchToPreviewOnMobile();
  viewportEmpty.style.display = "none";
  viewportInfo.style.display = "block";
  document.getElementById("model-name-label").textContent = filename || "model.stl";

  const loader = new THREE.STLLoader();
  loader.load(url, (geometry) => {
    if (currentMesh) scene.remove(currentMesh);

    geometry.computeVertexNormals();
    geometry.center();

    const color = CAD_COLORS[activeColorIndex];
    const material = new THREE.MeshStandardMaterial({
      color: color,
      metalness: 0.25,
      roughness: 0.4,
      wireframe: isWireframe
    });

    currentMesh = new THREE.Mesh(geometry, material);
    scene.add(currentMesh);

    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const dx = (bb.max.x - bb.min.x).toFixed(1);
    const dy = (bb.max.y - bb.min.y).toFixed(1);
    const dz = (bb.max.z - bb.min.z).toFixed(1);
    const triangleCount = geometry.attributes.position.count / 3;

    document.getElementById("model-stats-triangles").textContent = `${triangleCount.toLocaleString()} Triangles`;
    document.getElementById("model-stats-dim").textContent = `${dx} × ${dy} × ${dz} mm`;

    resetCamera();
  }, undefined, (err) => {
    console.error("Error loading STL:", err);
  });
}

function resetCamera() {
  if (!currentMesh || !camera || !controls) return;
  const geometry = currentMesh.geometry;
  geometry.computeBoundingSphere();
  const radius = geometry.boundingSphere.radius;
  const dist = radius * 2.8;

  camera.position.set(dist, dist * 0.9, dist * 1.2);
  camera.lookAt(0, 0, 0);
  controls.target.set(0, 0, 0);
  controls.update();
}

function toggleWireframe() {
  isWireframe = !isWireframe;
  document.getElementById("btn-wireframe").classList.toggle("active", isWireframe);
  if (currentMesh && currentMesh.material) {
    currentMesh.material.wireframe = isWireframe;
  }
}

function toggleGrid() {
  isGridVisible = !isGridVisible;
  document.getElementById("btn-grid").classList.toggle("active", isGridVisible);
  if (gridHelper) gridHelper.visible = isGridVisible;
}

function cycleColor() {
  activeColorIndex = (activeColorIndex + 1) % CAD_COLORS.length;
  const col = CAD_COLORS[activeColorIndex];
  if (currentMesh && currentMesh.material) {
    currentMesh.material.color.setHex(col);
  }
}

// --- Assets Management ---
async function loadAssets() {
  try {
    const res = await fetch(`${API_BASE}/exports`);
    if (!res.ok) return;
    const data = await res.json();
    const files = data.exports || [];
    assetCount.textContent = files.length;
    renderAssetCards(files);
  } catch (err) {
    console.error("Failed to load assets:", err);
  }
}

function renderAssetCards(files) {
  assetsGrid.innerHTML = "";
  if (files.length === 0) {
    assetsGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--color-steel); padding: 40px; font-family: var(--font-mono);">No generated CAD files found in workspace.</div>`;
    return;
  }

  files.forEach(f => {
    const card = document.createElement("div");
    card.className = "asset-card";
    card.setAttribute("data-tilt", "");
    const ext = f.filename.split(".").pop().toLowerCase();
    const dateStr = new Date(f.modified_at * 1000).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    });

    let extClass = "ext-step";
    if (ext === "stl") extClass = "ext-stl";
    else if (ext === "pdf") extClass = "ext-pdf";
    else if (ext === "dxf") extClass = "ext-dxf";
    else if (ext === "html") extClass = "ext-html";

    card.innerHTML = `
      <div class="asset-header">
        <span class="asset-ext-badge ${extClass}">${escapeHtml(ext)}</span>
        <span class="asset-meta">${formatBytes(f.size_bytes)}</span>
      </div>
      <div class="asset-name">${escapeHtml(f.filename)}</div>
      <div class="asset-meta">${dateStr}</div>
      <div class="asset-actions">
        <a href="${f.download_url}" download class="btn btn-primary btn-sm">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 2v9M4 8l4 4 4-4M2 14h12"/>
          </svg>
          <span>Download</span>
        </a>
        ${ext === "stl" ? `<button class="btn btn-secondary btn-sm" onclick="previewSTL('${f.download_url}', '${f.filename}')"><span>3D View</span></button>` : ''}
      </div>
    `;
    assetsGrid.appendChild(card);
  });
}

window.previewSTL = (url, filename) => {
  switchTab("3d");
  loadSTL(url, filename);
};

// --- Signature OptiPrime 3D Perspective Tilt & Spotlight (100% Identical to Portal) ---
function initCardTilt() {
  if (!window.matchMedia('(hover: hover)').matches) return;

  const CARD_ITEM_SELECTOR = '[data-tilt], .asset-card';
  let currentCard = null;

  const resetCard = (c) => {
    if (!c) return;
    c.style.setProperty('--rx', '0deg');
    c.style.setProperty('--ry', '0deg');
    c.style.setProperty('--mx', '50%');
    c.style.setProperty('--my', '0%');
  };

  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest(CARD_ITEM_SELECTOR);

    if (!card) {
      if (currentCard) {
        resetCard(currentCard);
        currentCard = null;
      }
      return;
    }

    if (currentCard && currentCard !== card) {
      resetCard(currentCard);
    }
    currentCard = card;

    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;

    // 100% identical formula from OptiPrime portal (index.html lines 739-742)
    card.style.setProperty('--rx', ((.5 - y) * 7).toFixed(2) + 'deg');
    card.style.setProperty('--ry', ((x - .5) * 9).toFixed(2) + 'deg');
    card.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
    card.style.setProperty('--my', (y * 100).toFixed(1) + '%');
  });

  document.addEventListener('pointerout', (e) => {
    if (currentCard && (!e.relatedTarget || !currentCard.contains(e.relatedTarget))) {
      resetCard(currentCard);
      currentCard = null;
    }
  });

  window.addEventListener('blur', () => {
    if (currentCard) {
      resetCard(currentCard);
      currentCard = null;
    }
  });
}

// --- Utilities ---
function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatMarkdown(text) {
  if (!text) return "";
  let out = escapeHtml(text);

  out = out.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code style='font-family: var(--font-mono); font-size: 0.88em; background: var(--color-carbon); padding: 2px 5px; border-radius: 4px; color: var(--color-periwinkle);'>$1</code>");

  if (out.includes("|")) {
    const lines = out.split("\n");
    let inTable = false;
    let tableHtml = "<table style='border-collapse: collapse; margin: 10px 0; font-family: var(--font-mono); font-size: 11px;'>";
    let newLines = [];

    for (let l of lines) {
      if (l.trim().startsWith("|") && l.trim().endsWith("|")) {
        if (!inTable) { inTable = true; }
        if (l.includes("---")) continue;
        const cells = l.split("|").slice(1, -1);
        tableHtml += "<tr style='border-bottom: var(--dash-soft);'>" + cells.map(c => `<td style='padding: 5px 10px; border: var(--dash-soft);'>${c.trim()}</td>`).join("") + "</tr>";
      } else {
        if (inTable) {
          tableHtml += "</table>";
          newLines.push(tableHtml);
          inTable = false;
          tableHtml = "<table style='border-collapse: collapse; margin: 10px 0; font-family: var(--font-mono); font-size: 11px;'>";
        }
        newLines.push(l);
      }
    }
    if (inTable) { tableHtml += "</table>"; newLines.push(tableHtml); }
    out = newLines.join("<br>");
  } else {
    out = out.replace(/\n/g, "<br>");
  }

  return out;
}
