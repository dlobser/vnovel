/*
 * StoryPlayer — self-contained visual novel runtime.
 *
 * IMPORTANT: this class must stay fully self-contained (no references to
 * anything outside the class except standard browser APIs). The editor's
 * "Publish" feature embeds StoryPlayer.toString() directly into the exported
 * standalone HTML file, so any outside dependency would break published
 * stories. For the same reason, never put the literal closing-script-tag
 * character sequence anywhere in this file.
 *
 * Story JSON format (produced by the editor's compileStory()):
 * {
 *   title: "My Story",
 *   entry: <nodeId|null>,
 *   vars: { characters:[], locations:[], collectibles:[], knowledge:[], missions:[] },
 *   varMeta: { missions: { "Mission Name": { info:"", required:true } }, ... },
 *   nodes: {
 *     <id>: {
 *       type: "dialogue"|"choice"|"traversal"|"logic",
 *       p: { ...node properties... },
 *       out: [targetIdOrNull, ...]   // indexed by output slot
 *     }
 *   }
 * }
 */
class StoryPlayer {

  static CSS = `
.sp-root { position:absolute; inset:0; overflow:hidden; background:#05060a; font-family:'Inter',system-ui,sans-serif; color:#e2e8f0; }
.sp-bg { position:absolute; inset:0; background-size:cover; background-position:center; transition:background-image .6s ease, opacity .6s ease; }
.sp-vignette { position:absolute; inset:0; background:linear-gradient(to bottom, rgba(0,0,0,.35) 0%, rgba(0,0,0,.1) 40%, rgba(0,0,0,.88) 100%); pointer-events:none; }

.sp-topbar { position:absolute; top:0; left:0; right:0; height:56px; display:flex; align-items:center; justify-content:space-between; padding:0 16px; z-index:20; background:linear-gradient(to bottom, rgba(0,0,0,.55), transparent); }
.sp-title { font-family:'EB Garamond',Georgia,serif; font-size:19px; letter-spacing:.5px; color:#fff; text-shadow:0 2px 6px rgba(0,0,0,.8); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:34%; }
.sp-hud { display:flex; align-items:center; gap:8px; }
.sp-hud-btn { background:rgba(10,12,18,.6); border:1px solid rgba(255,255,255,.14); color:#e2e8f0; border-radius:20px; padding:6px 14px; font-size:12px; cursor:pointer; display:flex; align-items:center; gap:6px; transition:.15s ease; backdrop-filter:blur(6px); }
.sp-hud-btn:hover { background:rgba(99,102,241,.35); border-color:rgba(99,102,241,.6); }
.sp-hud-btn.sp-attn { border-color:rgba(245,158,11,.8); box-shadow:0 0 12px rgba(245,158,11,.35); }
.sp-badge { background:#6366f1; color:#fff; border-radius:10px; min-width:17px; height:17px; font-size:10px; font-weight:700; display:inline-flex; align-items:center; justify-content:center; padding:0 4px; }

.sp-inv { display:flex; align-items:center; gap:5px; background:rgba(10,12,18,.6); border:1px solid rgba(255,255,255,.12); border-radius:20px; padding:5px 12px; font-size:11px; max-width:340px; overflow-x:auto; backdrop-filter:blur(6px); }
.sp-inv::-webkit-scrollbar { height:0; }
.sp-inv-chip { background:rgba(6,182,212,.18); border:1px solid rgba(6,182,212,.4); color:#67e8f9; border-radius:10px; padding:2px 8px; white-space:nowrap; }
.sp-inv-empty { color:#64748b; font-style:italic; }

.sp-panel { position:absolute; top:60px; right:12px; width:320px; max-height:calc(100% - 140px); background:rgba(12,14,20,.92); border:1px solid rgba(255,255,255,.12); border-radius:12px; z-index:30; display:flex; flex-direction:column; box-shadow:0 18px 50px rgba(0,0,0,.6); backdrop-filter:blur(10px); overflow:hidden; animation:spFadeIn .25s ease; }
.sp-panel.sp-hidden { display:none; }
.sp-panel-head { padding:12px 16px; font-size:12px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#94a3b8; border-bottom:1px solid rgba(255,255,255,.09); display:flex; justify-content:space-between; align-items:center; }
.sp-panel-x { background:none; border:none; color:#94a3b8; font-size:16px; cursor:pointer; }
.sp-panel-body { overflow-y:auto; padding:12px 16px; display:flex; flex-direction:column; gap:10px; }

.sp-mission { border:1px solid rgba(255,255,255,.1); border-left:3px solid #f59e0b; border-radius:0 8px 8px 0; background:rgba(255,255,255,.03); padding:10px 12px; font-size:12.5px; line-height:1.5; }
.sp-mission.sp-required { border-left-color:#ef4444; }
.sp-mission.sp-done { border-left-color:#10b981; opacity:.65; }
.sp-mission.sp-done .sp-mission-name { text-decoration:line-through; }
.sp-mission-name { font-weight:600; color:#fff; display:flex; align-items:center; gap:8px; justify-content:space-between; }
.sp-mission-tag { font-size:9px; font-weight:700; letter-spacing:.5px; text-transform:uppercase; border-radius:8px; padding:2px 7px; }
.sp-mission-tag.sp-req { background:rgba(239,68,68,.18); color:#f87171; border:1px solid rgba(239,68,68,.4); }
.sp-mission-tag.sp-opt { background:rgba(148,163,184,.15); color:#94a3b8; border:1px solid rgba(148,163,184,.3); }
.sp-mission-tag.sp-donetag { background:rgba(16,185,129,.18); color:#34d399; border:1px solid rgba(16,185,129,.4); }
.sp-mission-info { color:#94a3b8; font-size:11.5px; margin-top:4px; font-family:'EB Garamond',Georgia,serif; font-size:13px; }
.sp-panel-empty { color:#64748b; font-size:12px; font-style:italic; padding:6px 0; }

.sp-diary-entry { background:rgba(255,255,255,.03); border-left:3px solid #a855f7; padding:10px 12px; border-radius:0 8px 8px 0; font-size:13.5px; line-height:1.55; font-family:'EB Garamond',Georgia,serif; }
.sp-diary-label { color:#e2e8f0; }
.sp-diary-info { color:#94a3b8; font-size:13px; margin-top:5px; padding-top:5px; border-top:1px solid rgba(255,255,255,.07); white-space:pre-wrap; }

.sp-stage { position:absolute; inset:0; z-index:10; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; padding-bottom:36px; }

.sp-dialogue { width:min(860px, 92%); background:rgba(14,16,24,.88); border:1px solid rgba(255,255,255,.12); border-radius:14px; padding:26px 30px 34px; box-shadow:0 14px 40px rgba(0,0,0,.55); cursor:pointer; position:relative; backdrop-filter:blur(8px); animation:spFadeIn .3s ease; min-height:130px; }
.sp-dialogue:hover { border-color:rgba(99,102,241,.45); }
.sp-speaker { font-family:'EB Garamond',Georgia,serif; font-size:21px; font-weight:700; letter-spacing:.5px; display:inline-block; margin-bottom:10px; padding-bottom:3px; border-bottom:2px solid currentColor; }
.sp-text { font-family:'EB Garamond',Georgia,serif; font-size:19px; line-height:1.65; color:#f1f5f9; }
.sp-text .sp-tok { font-weight:600; }
.sp-next { position:absolute; bottom:12px; right:18px; font-size:11px; color:#94a3b8; animation:spPulse 1.6s infinite; font-family:'Inter',sans-serif; }
@keyframes spPulse { 0%,100% { opacity:.45; } 50% { opacity:1; } }
@keyframes spFadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }

.sp-choices { width:min(620px,92%); display:flex; flex-direction:column; gap:10px; margin-top:14px; }
.sp-choice { background:rgba(22,28,44,.85); border:1px solid rgba(255,255,255,.13); color:#fff; padding:13px 22px; border-radius:30px; font-size:15px; font-family:'EB Garamond',Georgia,serif; cursor:pointer; transition:.15s ease; text-align:center; backdrop-filter:blur(6px); position:relative; }
.sp-choice:hover { background:linear-gradient(135deg,#6366f1,#a855f7); border-color:transparent; transform:translateY(-2px); box-shadow:0 6px 20px rgba(99,102,241,.4); }
.sp-choice.sp-locked { opacity:.45; cursor:not-allowed; }
.sp-choice.sp-locked:hover { background:rgba(22,28,44,.85); transform:none; box-shadow:none; border-color:rgba(255,255,255,.13); }
.sp-choice-mission { display:inline-block; margin-left:8px; font-size:10px; font-family:'Inter',sans-serif; font-weight:700; letter-spacing:.5px; text-transform:uppercase; background:rgba(245,158,11,.2); color:#fbbf24; border:1px solid rgba(245,158,11,.45); border-radius:10px; padding:2px 8px; vertical-align:2px; }
.sp-lock-why { display:block; font-size:10.5px; font-family:'Inter',sans-serif; color:#94a3b8; margin-top:3px; }

.sp-dice { width:min(430px,92%); background:rgba(14,16,24,.92); border:1px solid rgba(255,255,255,.14); border-radius:16px; padding:24px; text-align:center; display:flex; flex-direction:column; align-items:center; gap:14px; box-shadow:0 16px 44px rgba(0,0,0,.6); backdrop-filter:blur(8px); animation:spFadeIn .3s ease; }
.sp-dice-title { font-family:'EB Garamond',Georgia,serif; font-size:21px; font-weight:700; color:#fbbf24; }
.sp-dice-score { font-size:13px; color:#94a3b8; }
.sp-dice-score b { color:#fff; font-size:16px; }
.sp-cube { width:76px; height:76px; background:linear-gradient(135deg,#f59e0b,#d97706); border-radius:12px; color:#fff; display:flex; align-items:center; justify-content:center; font-size:30px; font-weight:800; box-shadow:0 8px 24px rgba(245,158,11,.4); }
.sp-cube.sp-rolling { animation:spRoll .5s infinite linear; }
@keyframes spRoll { 0% { transform:rotate(0deg) scale(.9); } 50% { transform:rotate(180deg) scale(1.1); } 100% { transform:rotate(360deg) scale(.9); } }
.sp-roll-btn { background:linear-gradient(135deg,#6366f1,#a855f7); border:none; color:#fff; border-radius:30px; padding:12px 26px; font-size:14px; font-weight:600; cursor:pointer; width:100%; transition:.15s ease; }
.sp-roll-btn:hover { filter:brightness(1.15); }
.sp-roll-btn:disabled { opacity:.5; cursor:default; }
.sp-exit-btn { background:rgba(148,163,184,.12); border:1px solid rgba(148,163,184,.35); color:#cbd5e1; border-radius:30px; padding:9px 20px; font-size:12.5px; cursor:pointer; width:100%; transition:.15s ease; }
.sp-exit-btn:hover { background:rgba(239,68,68,.15); border-color:rgba(239,68,68,.4); color:#fca5a5; }
.sp-dice-desc { font-size:12px; color:#94a3b8; min-height:18px; }
.sp-dice-risks { width:100%; text-align:left; background:rgba(0,0,0,.25); border-radius:8px; padding:10px 12px; font-size:11px; color:#94a3b8; }
.sp-dice-risks div { display:flex; justify-content:space-between; margin-bottom:2px; }
.sp-risk-pct { color:#f87171; font-weight:600; }

.sp-toasts { position:absolute; top:64px; left:50%; transform:translateX(-50%); z-index:60; display:flex; flex-direction:column; gap:8px; align-items:center; pointer-events:none; }
.sp-toast { background:rgba(16,185,129,.92); color:#fff; padding:8px 18px; border-radius:20px; font-size:12.5px; font-weight:600; box-shadow:0 6px 18px rgba(0,0,0,.4); animation:spFadeIn .25s ease; }
.sp-toast.sp-toast-mission { background:rgba(245,158,11,.94); }
.sp-toast.sp-toast-info { background:rgba(99,102,241,.94); }

.sp-splash { position:absolute; inset:0; z-index:50; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:26px; background:radial-gradient(ellipse at center, #131627 0%, #05060a 75%); }
.sp-splash-title { font-family:'EB Garamond',Georgia,serif; font-size:clamp(34px, 6vw, 62px); color:#fff; text-align:center; letter-spacing:1px; text-shadow:0 4px 30px rgba(99,102,241,.5); padding:0 20px; }
.sp-splash-sub { color:#94a3b8; font-size:13px; letter-spacing:3px; text-transform:uppercase; }
.sp-begin { background:linear-gradient(135deg,#6366f1,#a855f7); color:#fff; border:none; border-radius:34px; padding:15px 52px; font-size:17px; font-family:'EB Garamond',Georgia,serif; letter-spacing:1px; cursor:pointer; box-shadow:0 10px 34px rgba(99,102,241,.45); transition:.2s ease; }
.sp-begin:hover { transform:translateY(-2px); box-shadow:0 14px 44px rgba(99,102,241,.65); }

.sp-ending { width:min(600px,92%); background:rgba(14,16,24,.92); border:1px solid rgba(255,255,255,.14); border-radius:16px; padding:36px; text-align:center; box-shadow:0 16px 44px rgba(0,0,0,.6); animation:spFadeIn .4s ease; margin-bottom:10vh; }
.sp-ending-title { font-family:'EB Garamond',Georgia,serif; font-size:30px; color:#34d399; margin-bottom:14px; }
.sp-ending-text { font-family:'EB Garamond',Georgia,serif; font-size:17px; color:#cbd5e1; line-height:1.6; margin-bottom:24px; }
.sp-ending-actions { display:flex; gap:12px; justify-content:center; }

/* Cast layer: everyone present in the scene, speaker emphasised.
   Lives outside .sp-stage so advancing a line doesn't remount the portraits. */
.sp-cast { position:absolute; left:0; right:0; bottom:150px; display:flex; justify-content:center; align-items:flex-end; gap:2%; pointer-events:none; z-index:5; height:min(480px,48vh); }
.sp-cast:empty { display:none; }
/* Scale/dim live on .sp-char; the entrance animation lives on the inner <img>.
   Kept apart because spSlideUp animates transform, which would otherwise
   override the speaker scale for the whole 0.4s the animation runs. */
.sp-char { display:flex; align-items:flex-end; justify-content:center; height:100%; flex:0 1 auto; min-width:0;
  transition:transform .3s ease, filter .3s ease, opacity .3s ease; transform-origin:bottom center;
  transform:scale(.86); opacity:.62; filter:brightness(.6) saturate(.8); }
.sp-char.sp-active { transform:scale(1); opacity:1; filter:none; z-index:6; }
.sp-char img { max-height:100%; max-width:100%; object-fit:contain; object-position:bottom; display:block; animation:spSlideUp .4s ease; }

/* Legacy single-portrait classes, retained for older published files */
.sp-char-container { display:flex; justify-content:center; align-items:flex-end; width:min(860px, 92%); height:min(480px, 48vh); pointer-events:none; margin-bottom:12px; z-index:5; }
.sp-char-img { max-height:100%; max-width:66%; object-fit:contain; animation:spSlideUp .4s ease; }
@keyframes spSlideUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
`;

  constructor(container, story, opts = {}) {
    this.container = container;
    this.story = story || { nodes: {}, vars: {}, entry: null };
    this.opts = opts; // { onExit: fn, standalone: bool }
    this.state = null;
    this._loopAudio = null;
    this._loopSrc = null;
    this._fadeTimer = null;
    this._begun = false;
    this._injectStyles();
  }

  _injectStyles() {
    if (document.getElementById("sp-player-styles")) return;
    const s = document.createElement("style");
    s.id = "sp-player-styles";
    s.textContent = StoryPlayer.CSS;
    document.head.appendChild(s);
  }

  // ---------- lifecycle ----------

  start(entryId, startState = null) {
    this._entryId = (entryId !== undefined && entryId !== null) ? entryId : this.story.entry;
    this.state = {
      inventory: startState && startState.inventory ? new Set(startState.inventory) : new Set(),
      knowledge: startState && startState.knowledge ? new Set(startState.knowledge) : new Set(),
      missions: startState && startState.missions ? new Map(Object.entries(startState.missions)) : new Map(),
      diary: [],
      scores: {}
    };
    if (startState) {
      if (startState.inventory && startState.inventory.length) {
        this.state.diary.push("Started with items: " + startState.inventory.join(", "));
      }
      if (startState.knowledge && startState.knowledge.length) {
        // One entry each, so every preset flag can show its own description
        startState.knowledge.forEach(k => {
          this.state.diary.push({ label: "Started knowing: " + k, key: k });
        });
      }
      if (startState.missions) {
        Object.entries(startState.missions).forEach(([name, status]) => {
          this.state.diary.push(`Mission "${name}" preset to: ${status}`);
        });
      }
    }
    this._stopAllAudio();
    if (this.opts.standalone && !this._begun) {
      this._renderSplash();
    } else {
      this._begin();
    }
  }

  destroy() {
    this._stopAllAudio();
    this.container.innerHTML = "";
    this.container.classList.remove("sp-root");
  }

  _begin() {
    this._begun = true;
    this._buildShell();
    const entryNode = this._node(this._entryId);
    if (!entryNode) {
      this._renderEnding("This story has no scenes yet. Add a Dialogue node in the editor to begin.");
      return;
    }
    this._goto(this._entryId);
  }

  _renderSplash() {
    this.container.classList.add("sp-root");
    this.container.innerHTML = `
      <div class="sp-splash">
        <div class="sp-splash-sub">A Story</div>
        <div class="sp-splash-title">${this._esc(this.story.title || "Untitled Story")}</div>
        <button class="sp-begin">Begin</button>
      </div>`;
    this.container.querySelector(".sp-begin").onclick = () => this._begin();
  }

  _buildShell() {
    this.container.classList.add("sp-root");
    this.container.innerHTML = `
      <div class="sp-bg"></div>
      <div class="sp-vignette"></div>
      <div class="sp-topbar">
        <div class="sp-title">${this._esc(this.story.title || "Untitled Story")}</div>
        <div class="sp-hud">
          <div class="sp-inv"><span>&#128188;</span><span class="sp-inv-items"><span class="sp-inv-empty">empty</span></span></div>
          <button class="sp-hud-btn sp-btn-missions">&#9873; Missions <span class="sp-badge">0</span></button>
          <button class="sp-hud-btn sp-btn-diary">&#128214; Diary</button>
          <button class="sp-hud-btn sp-btn-restart" title="Restart story">&#8635;</button>
          ${this.opts.onExit ? '<button class="sp-hud-btn sp-btn-exit">&#10005; Exit</button>' : ""}
        </div>
      </div>
      <div class="sp-panel sp-hidden sp-missions-panel">
        <div class="sp-panel-head"><span>Missions</span><button class="sp-panel-x">&times;</button></div>
        <div class="sp-panel-body"></div>
      </div>
      <div class="sp-panel sp-hidden sp-diary-panel">
        <div class="sp-panel-head"><span>Diary</span><button class="sp-panel-x">&times;</button></div>
        <div class="sp-panel-body"></div>
      </div>
      <div class="sp-toasts"></div>
      <div class="sp-cast"></div>
      <div class="sp-stage"></div>`;

    const q = sel => this.container.querySelector(sel);
    this.el = {
      bg: q(".sp-bg"),
      cast: q(".sp-cast"),
      stage: q(".sp-stage"),
      inv: q(".sp-inv-items"),
      missionsBtn: q(".sp-btn-missions"),
      missionsBadge: q(".sp-btn-missions .sp-badge"),
      missionsPanel: q(".sp-missions-panel"),
      diaryPanel: q(".sp-diary-panel"),
      toasts: q(".sp-toasts")
    };

    this.el.missionsBtn.onclick = () => this._togglePanel(this.el.missionsPanel);
    q(".sp-btn-diary").onclick = () => this._togglePanel(this.el.diaryPanel);
    q(".sp-btn-restart").onclick = () => this.start(this.story.entry);
    this.el.missionsPanel.querySelector(".sp-panel-x").onclick = () => this.el.missionsPanel.classList.add("sp-hidden");
    this.el.diaryPanel.querySelector(".sp-panel-x").onclick = () => this.el.diaryPanel.classList.add("sp-hidden");
    if (this.opts.onExit) q(".sp-btn-exit").onclick = () => this.opts.onExit();
    this._updateHUD();
  }

  _togglePanel(panel) {
    const others = [this.el.missionsPanel, this.el.diaryPanel].filter(p => p !== panel);
    others.forEach(p => p.classList.add("sp-hidden"));
    panel.classList.toggle("sp-hidden");
    this._renderPanels();
  }

  // ---------- graph walking ----------

  _node(id) { return (id === null || id === undefined) ? null : this.story.nodes[id]; }

  _goto(id) {
    const node = this._node(id);
    if (!node) { this._clearCast(); this._renderEnding("The narrative reaches a quiet end. Thank you for playing."); return; }
    this._currentId = id;
    // The cast layer sits outside .sp-stage, so it survives the stage rebuild —
    // clear it here or portraits linger over choices, traversals and endings.
    if (node.type !== "dialogue") this._clearCast();
    switch (node.type) {
      case "dialogue": return this._playDialogue(node);
      case "choice": return this._playChoice(node);
      case "traversal": return this._playTraversal(node, id);
      case "logic": return this._playLogic(node);
      default: return this._playDialogue(node);
    }
  }

  _out(node, slot) {
    const t = node.out && node.out[slot];
    return (t === undefined || t === null) ? null : t;
  }

  // ---------- dialogue ----------

  _playDialogue(node) {
    const p = node.p || {};
    this._setBackground(p.background);
    if (p.audioLoop) this._setLoop(p.audioLoop);
    if (p.audioOneShot) this._playOneShot(p.audioOneShot);

    // Rewards & mission transitions on entering the node
    if (p.rewardItems && !this.state.inventory.has(p.rewardItems)) {
      this.state.inventory.add(p.rewardItems);
      this._toast("Acquired: " + p.rewardItems);
    }
    if (p.rewardKnowledge && !this.state.knowledge.has(p.rewardKnowledge)) {
      this.state.knowledge.add(p.rewardKnowledge);
      // Keep the key alongside the label so the diary can show what the author
      // wrote about this flag, not just that it was found
      this.state.diary.push({ label: 'Discovered: "' + p.rewardKnowledge + '"', key: p.rewardKnowledge });
      this._toast("Diary updated", "info");
    }
    if (p.startMission) this._acceptMission(p.startMission);
    if (p.completeMission) this._completeMission(p.completeMission);
    this._updateHUD();

    this._queue = String(p.text || "...").split("\n").map(l => l.trim()).filter(Boolean);
    if (this._queue.length === 0) this._queue = ["..."];
    this._queueIdx = 0;
    this._renderLine(node);
  }

  _renderLine(node) {
    const p = node.p || {};
    const line = this._queue[this._queueIdx];
    const parsed = this._parseLine(line);
    const last = this._queueIdx >= this._queue.length - 1;

    this._renderCast(node, parsed.speaker);

    this.el.stage.innerHTML = `
      <div class="sp-dialogue">
        ${parsed.speaker ? `<div class="sp-speaker" style="color:${this._charColor(parsed.speaker)}">${this._esc(parsed.speaker)}</div>` : ""}
        <div class="sp-text">${this._richText(parsed.text)}</div>
        <div class="sp-next">${last ? "click to continue" : `next (${this._queueIdx + 1}/${this._queue.length})`} &#8250;</div>
      </div>`;
    this.el.stage.querySelector(".sp-dialogue").onclick = () => {
      if (this._queueIdx < this._queue.length - 1) {
        this._queueIdx++;
        this._renderLine(node);
      } else {
        this._goto(this._out(node, 0));
      }
    };
  }

  _clearCast() {
    this._castKey = null;
    if (this.el && this.el.cast) this.el.cast.innerHTML = "";
  }

  _charImage(name) {
    const chars = this.story.varMeta && this.story.varMeta.characters;
    const meta = chars && chars[name];
    const img = meta && meta.image;
    return (typeof img === "string" && img.trim()) ? img : null;
  }

  // Who to show for this node: every distinct speaker in its dialogue, in first-
  // spoken order, skipping anyone with no portrait so they get no slot at all.
  _castForNode(node) {
    const p = node.p || {};
    if (p.showCharacterImages === false) return [];
    const seen = new Set();
    const cast = [];
    String(p.text || "").split("\n").forEach(line => {
      const t = line.trim();
      if (!t) return;
      const speaker = this._parseLine(t).speaker;
      if (!speaker || seen.has(speaker)) return;
      seen.add(speaker);
      const img = this._charImage(speaker);
      if (img) cast.push({ name: speaker, img });
    });
    return cast;
  }

  // Rebuilds the row only when the cast changes; otherwise just moves the
  // highlight, so portraits don't replay their entrance on every click.
  _renderCast(node, speaker) {
    if (!this.el || !this.el.cast) return;
    const cast = this._castForNode(node);
    const key = cast.map(c => c.name + "|" + c.img).join("~");

    if (key !== this._castKey) {
      this._castKey = key;
      this.el.cast.innerHTML = cast.map(c =>
        `<div class="sp-char" data-char="${this._esc(c.name)}">
           <img src="${this._esc(c.img)}" alt="${this._esc(c.name)}">
         </div>`
      ).join("");
    }

    this.el.cast.querySelectorAll(".sp-char").forEach(el => {
      el.classList.toggle("sp-active", el.dataset.char === speaker);
    });
  }

  // Accepts "{Name}: text", "{Name} text", "Name: text"
  _parseLine(line) {
    let m = line.match(/^\{([^}]+)\}\s*:?\s*(.*)$/s);
    if (m) return { speaker: m[1].trim(), text: m[2] };
    m = line.match(/^([A-Za-z][A-Za-z0-9 .'\-]{0,28}?)\s*:\s+(.*)$/s);
    if (m) return { speaker: m[1].trim(), text: m[2] };
    return { speaker: null, text: line };
  }

  _richText(text) {
    // Inline {Token} references get colored
    let html = this._esc(text);
    html = html.replace(/\{([^}]+)\}/g, (_, name) =>
      `<span class="sp-tok" style="color:${this._charColor(name)}">${name}</span>`);
    return html;
  }

  _charColor(name) {
    const n = String(name).toLowerCase().trim();
    if (n === "narrator") return "#94a3b8";
    let h = 0;
    for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360}, 70%, 68%)`;
  }

  // ---------- choice ----------

  _playChoice(node) {
    const p = node.p || {};
    this._setBackground(p.background);
    if (p.audioLoop) this._setLoop(p.audioLoop);
    if (p.audioOneShot) this._playOneShot(p.audioOneShot);

    const choices = p.choices || [];
    let html = `
      <div class="sp-dialogue" style="cursor:default; min-height:auto;">
        <div class="sp-speaker" style="color:#94a3b8;">Narrator</div>
        <div class="sp-text">${this._richText(p.title || "What will you do?")}</div>
      </div>
      <div class="sp-choices">`;
    choices.forEach((c, i) => {
      const ok = this._evalCond(c.condition);
      const missionBadge = c.mission ? `<span class="sp-choice-mission">&#9873; ${this._esc(c.mission)}</span>` : "";
      if (ok) {
        html += `<button class="sp-choice" data-i="${i}">${this._esc(c.text)}${missionBadge}</button>`;
      } else {
        html += `<button class="sp-choice sp-locked" disabled>${this._esc(c.text)}${missionBadge}<span class="sp-lock-why">requires: ${this._esc(c.condition)}</span></button>`;
      }
    });
    html += "</div>";
    this.el.stage.innerHTML = html;
    this.el.stage.querySelectorAll(".sp-choice:not(.sp-locked)").forEach(btn => {
      btn.onclick = () => {
        const i = parseInt(btn.dataset.i, 10);
        const choice = choices[i];
        if (choice.mission) this._acceptMission(choice.mission);
        this._updateHUD();
        this._goto(this._out(node, i));
      };
    });
    this._updateHUD();
  }

  // ---------- traversal (dice maze) ----------

  _playTraversal(node, id) {
    const p = node.p || {};
    this._setBackground(p.background);
    if (p.audioLoop) this._setLoop(p.audioLoop);
    if (p.audioOneShot) this._playOneShot(p.audioOneShot);

    const key = "n" + id;
    if (this.state.scores[key] === undefined) this.state.scores[key] = 0;
    const target = p.targetAccumulation || 100;
    const outcomes = p.outcomes || [];
    const earlyExitSlot = outcomes.length + 1;
    const hasEarlyExit = this._out(node, earlyExitSlot) !== null;

    let risksHtml = "";
    if (outcomes.length) {
      risksHtml = `<div class="sp-dice-risks">
        ${outcomes.map(o => `<div><span>&bull; ${this._esc(o.label)}</span><span class="sp-risk-pct">${o.probability}%</span></div>`).join("")}
      </div>`;
    }

    this.el.stage.innerHTML = `
      <div class="sp-dice">
        <div class="sp-dice-title">${this._esc(p.title || "Maze Challenge")}</div>
        <div class="sp-dice-score">Progress: <b class="sp-score-val">${this.state.scores[key]}</b> / ${target}</div>
        <div class="sp-cube">?</div>
        <button class="sp-roll-btn">Roll d20</button>
        ${hasEarlyExit ? '<button class="sp-exit-btn">&#128682; Take the early exit &mdash; leave before risking another roll</button>' : ""}
        <div class="sp-dice-desc">Each roll adds points toward escape&hellip; but every roll is a risk.</div>
        ${risksHtml}
      </div>`;

    const cube = this.el.stage.querySelector(".sp-cube");
    const btn = this.el.stage.querySelector(".sp-roll-btn");
    const desc = this.el.stage.querySelector(".sp-dice-desc");
    const scoreEl = this.el.stage.querySelector(".sp-score-val");
    const exitBtn = this.el.stage.querySelector(".sp-exit-btn");
    if (exitBtn) exitBtn.onclick = () => this._goto(this._out(node, earlyExitSlot));

    btn.onclick = () => {
      btn.disabled = true;
      if (exitBtn) exitBtn.disabled = true;
      cube.classList.add("sp-rolling");
      cube.textContent = "?";
      setTimeout(() => {
        cube.classList.remove("sp-rolling");
        const roll = Math.floor(Math.random() * 20) + 1;
        cube.textContent = roll;

        let triggered = null;
        for (const o of outcomes) {
          const chance = o.probability !== undefined ? o.probability : 10;
          if (Math.random() * 100 < chance) { triggered = o; break; }
        }

        if (triggered) {
          desc.innerHTML = `<span style="color:#f87171;font-weight:600;">${this._esc(triggered.label)}!</span> ${this._esc(triggered.description || "")}`;
          setTimeout(() => {
            const slot = outcomes.indexOf(triggered) + 1;
            const targetId = this._out(node, slot);
            if (targetId !== null) {
              this._goto(targetId);
            } else {
              this._toast("Event path not connected — restarting room", "info");
              this.state.scores[key] = 0;
              this._playTraversal(node, id);
            }
          }, 1800);
          return;
        }

        this.state.scores[key] += roll;
        scoreEl.textContent = this.state.scores[key];
        if (this.state.scores[key] >= target) {
          desc.innerHTML = `<span style="color:#34d399;font-weight:600;">You made it out! (+${roll})</span>`;
          setTimeout(() => this._goto(this._out(node, 0)), 1300);
        } else {
          desc.textContent = `Rolled ${roll} — keep going to reach ${target}.`;
          btn.disabled = false;
          if (exitBtn) exitBtn.disabled = false;
        }
      }, 700);
    };
  }

  // ---------- logic gate ----------

  _playLogic(node) {
    const ok = this._evalCond((node.p || {}).condition);
    this._goto(this._out(node, ok ? 0 : 1));
  }

  // ---------- missions ----------

  _acceptMission(name) {
    if (!name || this.state.missions.has(name)) return;
    this.state.missions.set(name, "active");
    this._toast("Mission accepted: " + name, "mission");
    this._pulseMissions();
  }

  _completeMission(name) {
    if (!name) return;
    if (this.state.missions.get(name) === "done") return;
    this.state.missions.set(name, "done");
    this._toast("Mission complete: " + name, "mission");
    this._pulseMissions();
  }

  _missionMeta(name) {
    const vm = this.story.varMeta || {};
    return (vm.missions && vm.missions[name]) || {};
  }

  _knowledgeMeta(name) {
    const vm = this.story.varMeta || {};
    return (vm.knowledge && vm.knowledge[name]) || {};
  }

  _pulseMissions() {
    this._updateHUD();
    if (!this.el) return;
    this.el.missionsBtn.classList.add("sp-attn");
    setTimeout(() => this.el.missionsBtn && this.el.missionsBtn.classList.remove("sp-attn"), 2600);
  }

  // ---------- conditions ----------
  // Supported: has_item('x')  has_knowledge('x')  mission_active('x')  mission_done('x')
  // Multiple checks in one expression are ANDed together.

  _evalCond(cond) {
    if (!cond || !String(cond).trim()) return true;
    let ok = true;
    const scan = (fnName, test) => {
      const re = new RegExp(fnName + "\\(['\"]([^'\"]+)['\"]\\)", "g");
      let m;
      while ((m = re.exec(cond))) { if (!test(m[1])) ok = false; }
    };
    scan("has_item", v => this.state.inventory.has(v));
    scan("has_knowledge", v => this.state.knowledge.has(v));
    scan("mission_active", v => this.state.missions.get(v) === "active");
    scan("mission_done", v => this.state.missions.get(v) === "done");
    return ok;
  }

  // ---------- HUD, panels, endings ----------

  _updateHUD() {
    if (!this.el) return;
    // Inventory
    if (this.state.inventory.size === 0) {
      this.el.inv.innerHTML = '<span class="sp-inv-empty">empty</span>';
    } else {
      this.el.inv.innerHTML = Array.from(this.state.inventory)
        .map(i => `<span class="sp-inv-chip">${this._esc(i)}</span>`).join("");
    }
    // Missions badge counts active only
    let active = 0;
    this.state.missions.forEach(v => { if (v === "active") active++; });
    this.el.missionsBadge.textContent = active;
    this._renderPanels();
  }

  _renderPanels() {
    if (!this.el) return;
    // Missions panel
    const mBody = this.el.missionsPanel.querySelector(".sp-panel-body");
    if (this.state.missions.size === 0) {
      mBody.innerHTML = '<div class="sp-panel-empty">No missions accepted yet.</div>';
    } else {
      let html = "";
      this.state.missions.forEach((status, name) => {
        const meta = this._missionMeta(name);
        const done = status === "done";
        html += `
          <div class="sp-mission ${meta.required ? "sp-required" : ""} ${done ? "sp-done" : ""}">
            <div class="sp-mission-name">
              <span>${this._esc(name)}</span>
              ${done
                ? '<span class="sp-mission-tag sp-donetag">done</span>'
                : (meta.required ? '<span class="sp-mission-tag sp-req">required</span>' : '<span class="sp-mission-tag sp-opt">optional</span>')}
            </div>
            ${meta.info ? `<div class="sp-mission-info">${this._esc(meta.info)}</div>` : ""}
          </div>`;
      });
      mBody.innerHTML = html;
    }
    // Diary panel
    const dBody = this.el.diaryPanel.querySelector(".sp-panel-body");
    dBody.innerHTML = this.state.diary.length
      ? this.state.diary.map(e => {
          // Entries are {label, key}; bare strings are still accepted
          const entry = (typeof e === "string") ? { label: e } : (e || {});
          const info = entry.key ? this._knowledgeMeta(entry.key).info : "";
          return `<div class="sp-diary-entry">
            <div class="sp-diary-label">${this._esc(entry.label || "")}</div>
            ${info ? `<div class="sp-diary-info">${this._esc(info)}</div>` : ""}
          </div>`;
        }).join("")
      : '<div class="sp-panel-empty">Nothing discovered yet.</div>';
  }

  _renderEnding(message) {
    if (!this.el) this._buildShell();
    // Any required missions left unfinished?
    let unfinished = [];
    this.state.missions.forEach((status, name) => {
      if (status !== "done" && this._missionMeta(name).required) unfinished.push(name);
    });
    const missionNote = unfinished.length
      ? `<div style="color:#f87171; font-size:13px; margin-bottom:16px;">Unfinished required missions: ${unfinished.map(n => this._esc(n)).join(", ")}</div>`
      : "";
    this.el.stage.innerHTML = `
      <div class="sp-ending">
        <div class="sp-ending-title">&#10022; The End &#10022;</div>
        <div class="sp-ending-text">${this._esc(message)}</div>
        ${missionNote}
        <div class="sp-ending-actions">
          <button class="sp-roll-btn" style="width:auto;" data-act="restart">Play Again</button>
          ${this.opts.onExit ? '<button class="sp-exit-btn" style="width:auto;" data-act="exit">Back to Editor</button>' : ""}
        </div>
      </div>`;
    this.el.stage.querySelector('[data-act="restart"]').onclick = () => this.start(this.story.entry);
    const ex = this.el.stage.querySelector('[data-act="exit"]');
    if (ex) ex.onclick = () => this.opts.onExit();
  }

  // ---------- background & audio ----------

  _setBackground(value) {
    if (!this.el) return;
    const v = String(value || "").trim();
    let css;
    if (!v) {
      css = "linear-gradient(135deg, #1e1b4b, #0f172a)";
    } else if (v.includes("gradient(")) {
      css = v;
      // blob: has no file extension, so it needs the protocol test — the editor
      // resolves project-folder images to blob URLs for playback
    } else if (/^(blob:|data:|https?:|\.{0,2}\/)/.test(v) || /\.(png|jpe?g|gif|webp|avif)$/i.test(v)) {
      css = `url("${v.replace(/"/g, '%22')}")`;
    } else {
      css = "linear-gradient(135deg, #1e1b4b, #0f172a)";
    }
    this.el.bg.style.backgroundImage = css;
  }

  _setLoop(src) {
    if (!src || src === this._loopSrc) return;
    this._loopSrc = src;
    if (this._fadeTimer) { clearInterval(this._fadeTimer); this._fadeTimer = null; }
    const old = this._loopAudio;
    const next = new Audio(src);
    next.loop = true;
    next.volume = 0;
    const p = next.play();
    if (p && p.catch) p.catch(() => {});
    this._loopAudio = next;
    // Crossfade over ~700ms
    let step = 0;
    this._fadeTimer = setInterval(() => {
      step++;
      const t = Math.min(1, step / 14);
      next.volume = t;
      if (old) old.volume = Math.max(0, 1 - t);
      if (t >= 1) {
        clearInterval(this._fadeTimer);
        this._fadeTimer = null;
        if (old) { old.pause(); old.src = ""; }
      }
    }, 50);
  }

  _playOneShot(src) {
    if (!src) return;
    const a = new Audio(src);
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
  }

  _stopAllAudio() {
    if (this._fadeTimer) { clearInterval(this._fadeTimer); this._fadeTimer = null; }
    if (this._loopAudio) { this._loopAudio.pause(); this._loopAudio.src = ""; this._loopAudio = null; }
    this._loopSrc = null;
  }

  // ---------- misc ----------

  _toast(msg, kind) {
    if (!this.el) return;
    const t = document.createElement("div");
    t.className = "sp-toast" + (kind ? " sp-toast-" + kind : "");
    t.textContent = msg;
    this.el.toasts.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }

  _esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
}
