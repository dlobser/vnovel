// App initialization & State Management
window.addEventListener('DOMContentLoaded', () => {
  VNovelApp.init();
});

const VNovelApp = {
  graph: null,
  canvas: null,
  activeNode: null,
  player: null,
  gamePlaying: false,
  projectTitle: "Untitled Story",

  // Globals Lists for Autocomplete and Variables Quick-Add
  globalVars: {
    characters: ["Hero", "Goblin", "Wizard", "Narrator"],
    locations: ["Dark Forest", "Castle Keep", "Secret Cave"],
    collectibles: ["rusty_key", "healing_potion", "ancient_coin"],
    knowledge: ["heard_rustle", "met_wizard", "found_secret"],
    missions: ["Find the Rusty Key"]
  },

  // Per-item metadata: background info text, mission required flag, etc.
  varMeta: {
    missions: {
      "Find the Rusty Key": { info: "An old iron key is said to be buried near the gate roots.", required: false }
    }
  },

  // Bookmarks list
  bookmarks: [],

  // Undo system
  _states: [],
  _statePtr: -1,
  _restoring: false,
  _persistTimer: null,

  // Inspector audio preview
  _previewAudio: null,
  _previewBtn: null,

  VAR_CATEGORIES: [
    { key: 'characters', label: 'Characters', singular: 'character', cssClass: 'character' },
    { key: 'locations', label: 'Locations', singular: 'location', cssClass: 'location' },
    { key: 'collectibles', label: 'Collectibles', singular: 'item', cssClass: 'collectible' },
    { key: 'knowledge', label: 'Knowledge (Diary)', singular: 'flag', cssClass: 'knowledge' },
    { key: 'missions', label: 'Missions', singular: 'mission', cssClass: 'mission' }
  ],

  MODELS: {
    anthropic: [
      { id: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet" },
      { id: "claude-3-5-haiku-latest", name: "Claude 3.5 Haiku" },
      { id: "claude-3-opus-latest", name: "Claude 3 Opus" }
    ],
    gemini: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash" },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro" }
    ]
  },

  // ================= INIT =================

  init() {
    this.initTheme();
    this.initGraph();
    this.initUI();
    this.registerEventHandlers();
    this.loadDemoProject();
    this.initUndo();

    // Auto-save to localStorage periodically
    setInterval(() => this.saveToLocalStorage(), 15000);
  },

  // 1. LiteGraph Initialization & Registration
  initGraph() {
    if (typeof LGraph === 'undefined') {
      console.error("LiteGraph is not loaded. Ensure CDN links are intact.");
      return;
    }

    this.graph = new LGraph();

    const canvasEl = document.getElementById("graph_canvas");
    this.canvas = new LGraphCanvas(canvasEl, this.graph);
    this.canvas.connections_width = 3;
    this.canvas.render_shadows = true;
    this.canvas.show_info = false;
    this.canvas.allow_searchbox = false;
    this.applyCanvasTheme();

    // Match the canvas backing store to its on-screen size (otherwise it stays
    // at the 300x150 default and CSS stretches it, making everything look huge)
    this.resizeCanvas();
    window.addEventListener("resize", () => this.resizeCanvas());

    const self = this;
    // Double-click a node -> open Context Inspector (hook both callbacks;
    // different LiteGraph builds fire different ones)
    this.canvas.onNodeDblClicked = function(node) { self.openInspector(node); };
    this.canvas.onShowNodePanel = function(node) { self.openInspector(node); };

    // Double-click on EMPTY canvas -> quick-add a Dialogue node instead of
    // LiteGraph's default node search box
    this.canvas.showSearchBox = function() {
      const pos = self.canvas.graph_mouse ? [...self.canvas.graph_mouse] : self.viewCenter();
      self.addNodeAt("vnovel/passthrough", pos);
    };

    this.registerCustomNodes();
    this.purgeDefaultNodeTypes();
    this.installCustomMenus();
    this.installMultiInputSupport();

    this.graph.start();
  },

  resizeCanvas() {
    if (!this.canvas) return;
    const container = document.getElementById("canvas_container");
    if (!container) return;
    this.canvas.resize(container.clientWidth, container.clientHeight);
  },

  applyCanvasTheme() {
    if (!this.canvas) return;
    const light = document.body.classList.contains("light");
    const bg = light ? "#dde1e9" : "#0f1015";
    this.canvas.background_color = bg;
    this.canvas.clear_background_color = bg;
    this.canvas.grid_color = light ? "#cdd2dc" : "#181a24";
    this.canvas.draw(true, true);
  },

  viewCenter() {
    const ds = this.canvas.ds;
    return [
      (this.canvas.canvas.width / 2) / ds.scale - ds.offset[0],
      (this.canvas.canvas.height / 2) / ds.scale - ds.offset[1]
    ];
  },

  // Remove every built-in LiteGraph node type so only vnovel story nodes are
  // ever available in menus and searches.
  purgeDefaultNodeTypes() {
    const reg = LiteGraph.registered_node_types || {};
    Object.keys(reg).forEach(t => {
      if (!t.startsWith("vnovel/")) delete reg[t];
    });
    if (LiteGraph.Nodes) LiteGraph.Nodes = {};
  },

  // Replace LiteGraph's default context menus with story-focused ones
  installCustomMenus() {
    const self = this;

    this.canvas.getCanvasMenuOptions = function() {
      const pos = self.canvas.graph_mouse ? [...self.canvas.graph_mouse] : self.viewCenter();
      const mk = (label, type) => ({ content: label, callback: () => self.addNodeAt(type, pos) });
      return [
        mk("\u{1F4AC} Add Dialogue", "vnovel/passthrough"),
        mk("\u{1F500} Add Choice", "vnovel/choice"),
        mk("\u{1F3B2} Add Traversal", "vnovel/traversal"),
        mk("⚙️ Add Logic Gate", "vnovel/logic_gate")
      ];
    };

    this.canvas.getNodeMenuOptions = function(node) {
      return [
        { content: "▶ Play from here", callback: () => self.startPlayback(node) },
        { content: "✎ Open inspector", callback: () => self.openInspector(node) },
        { content: "⧉ Duplicate (Ctrl+D)", callback: () => self.duplicateNode(node) },
        null,
        {
          content: "\u{1F5D1} Remove (Del)",
          callback: () => {
            self.graph.remove(node);
            if (self.activeNode === node) self.closeInspector();
            self.renderBookmarks();
            self.checkpoint();
          }
        }
      ];
    };
  },

  // LiteGraph normally allows only ONE connection per input — connecting a
  // second wire silently disconnects the first. For a story graph we want
  // many-to-one (choices/outcomes from different branches converging on the
  // same scene), so:
  //  1. connect() is patched to keep existing incoming links alive,
  //  2. drawConnections() is replaced with a version that renders every link
  //     in the graph (the stock one only draws input.link, i.e. one per input),
  //  3. removing a node purges any extra links that pointed at it.
  installMultiInputSupport() {
    const self = this;

    if (!LGraphNode.prototype._vnovelMultiInput) {
      LGraphNode.prototype._vnovelMultiInput = true;
      const origConnect = LGraphNode.prototype.connect;

      LGraphNode.prototype.connect = function(slot, target_node, target_slot) {
        target_slot = target_slot || 0;
        const graph = this.graph;

        // Resolve slots to numeric indexes the same way LiteGraph will
        let inputIndex = target_slot;
        if (typeof target_slot === "string" && target_node.findInputSlot) {
          inputIndex = target_node.findInputSlot(target_slot);
        }
        let originSlot = slot;
        if (typeof slot === "string" && this.findOutputSlot) {
          originSlot = this.findOutputSlot(slot);
        }

        // Skip exact duplicates (same output slot -> same input slot)
        if (graph && graph.links) {
          for (const id in graph.links) {
            const L = graph.links[id];
            if (L && L.origin_id === this.id && L.origin_slot === originSlot &&
                target_node && L.target_id === target_node.id && L.target_slot === inputIndex) {
              return L;
            }
          }
        }

        // Temporarily hide an occupied input so the original connect()
        // doesn't auto-disconnect it — both links then coexist.
        const input = target_node && target_node.inputs ? target_node.inputs[inputIndex] : null;
        let savedLinkId = null;
        if (input && input.link != null) {
          savedLinkId = input.link;
          input.link = null;
        }
        let ret;
        try {
          ret = origConnect.call(this, slot, target_node, target_slot);
        } finally {
          // If the connect failed/was refused, restore the original link
          if (savedLinkId != null && input && input.link == null) {
            input.link = savedLinkId;
          }
        }
        return ret;
      };
    }

    // Render EVERY link in the registry, not just each input's single link
    this.canvas.drawConnections = function(ctx) {
      const graph = this.graph;
      if (!graph || !graph.links) return;
      if (this.visible_links) this.visible_links.length = 0;
      ctx.lineWidth = this.connections_width;
      ctx.fillStyle = "#AAA";
      ctx.strokeStyle = "#AAA";
      ctx.globalAlpha = this.editor_alpha;
      for (const id in graph.links) {
        const link = graph.links[id];
        if (!link) continue;
        const originNode = graph.getNodeById(link.origin_id);
        const targetNode = graph.getNodeById(link.target_id);
        if (!originNode || !targetNode) continue;
        const start = originNode.getConnectionPos(false, link.origin_slot);
        const end = targetNode.getConnectionPos(true, link.target_slot);
        const color = link.color || this.default_link_color;
        this.renderLink(ctx, start, end, link, false, 0, color, LiteGraph.RIGHT, LiteGraph.LEFT);
      }
      ctx.globalAlpha = 1;
    };

    // When a node is removed, LiteGraph only tears down the links its inputs
    // still reference — with many-to-one there can be extras. Purge them.
    this.graph.onNodeRemoved = function(node) {
      const g = self.graph;
      Object.keys(g.links || {}).forEach(id => {
        const L = g.links[id];
        if (L && (L.target_id === node.id || L.origin_id === node.id)) {
          g.removeLink(Number(id));
        }
      });
    };
  },

  addNodeAt(type, pos) {
    const node = LiteGraph.createNode(type);
    if (!node) return null;
    node.pos = [pos[0], pos[1]];

    // Auto-connect: if exactly one node is selected and it has a free output,
    // wire it into the new node so writers can chain scenes rapidly.
    const sel = Object.values(this.canvas.selected_nodes || {});
    const prev = sel.length === 1 ? sel[0] : null;

    this.graph.add(node);

    if (prev && prev.outputs && node.inputs && node.inputs.length) {
      const freeSlot = prev.outputs.findIndex(o => !o.links || o.links.length === 0);
      if (freeSlot !== -1) prev.connect(freeSlot, node, 0);
    }

    this.canvas.selectNode(node);
    this.openInspector(node);
    this.checkpoint();
    return node;
  },

  duplicateNode(node) {
    if (!node) return;
    const c = node.clone();
    if (!c) return;
    c.pos = [node.pos[0] + 40, node.pos[1] + 40];
    this.graph.add(c);
    this.canvas.selectNode(c);
    this.checkpoint();
  },

  duplicateSelection() {
    const sel = Object.values(this.canvas.selected_nodes || {});
    sel.forEach(n => this.duplicateNode(n));
  },

  deleteSelection() {
    const sel = Object.values(this.canvas.selected_nodes || {});
    if (!sel.length) return;
    const hadActive = sel.includes(this.activeNode);
    sel.forEach(n => this.graph.remove(n));
    this.canvas.selected_nodes = {};
    if (hadActive) this.closeInspector();
    this.renderBookmarks();
    this.checkpoint();
    this.toast(`Deleted ${sel.length} node${sel.length > 1 ? "s" : ""}`, "warning");
  },

  // Register Custom VNovel Node Archetypes
  registerCustomNodes() {
    const self = this;

    // A. DIALOGUE (PASSTHROUGH) NODE
    function PassthroughNode() {
      this.addInput("In", LiteGraph.ACTION);
      this.addOutput("Out", LiteGraph.ACTION);

      this.properties = {
        title: "Dialogue",
        location: "Dark Forest",
        charactersPresent: "", // legacy, kept for old saves
        text: "Hero: Did you hear that?\nGoblin: Run!",
        audioLoop: "",
        audioLoopName: "",
        audioOneShot: "",
        audioOneShotName: "",
        background: "",
        backgroundName: "",
        showCharacterImages: true,
        rewardItems: "",
        rewardKnowledge: "",
        startMission: "",
        completeMission: "",
        isChapterStart: false
      };

      this.size = [240, 110];
    }

    PassthroughNode.title = "Dialogue";
    PassthroughNode.color = "#1e3a8a";
    PassthroughNode.bgcolor = "#191d28";

    PassthroughNode.prototype.onDrawForeground = function(ctx) {
      if (this.flags.collapsed) return;
      ctx.font = "10px Inter, sans-serif";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(`Loc: ${this.properties.location || "—"}`, 12, 45);

      let textSnippet = (this.properties.text || "").split("\n")[0] || "";
      if (textSnippet.length > 30) textSnippet = textSnippet.substring(0, 27) + "...";
      ctx.fillStyle = "#e2e8f0";
      ctx.fillText(`"${textSnippet}"`, 12, 62);

      let y = 79;
      if (this.properties.isChapterStart) {
        ctx.fillStyle = "#10b981";
        ctx.fillText("★ Bookmark Entry", 12, y); y += 15;
      }
      if (this.properties.startMission) {
        ctx.fillStyle = "#fbbf24";
        ctx.fillText(`⚑ Starts: ${this.properties.startMission}`, 12, y); y += 15;
      }
      if (this.properties.completeMission) {
        ctx.fillStyle = "#34d399";
        ctx.fillText(`✓ Completes: ${this.properties.completeMission}`, 12, y); y += 15;
      }
      if (this.properties.background) {
        ctx.fillStyle = "#64748b";
        ctx.fillText(`\u{1F5BC} ${this.properties.backgroundName || "background set"}`, 12, y); y += 15;
      }
      const needed = y + 8;
      if (this.size[1] < needed) this.size[1] = needed;
    };

    LiteGraph.registerNodeType("vnovel/passthrough", PassthroughNode);

    // B. CHOICE NODE
    function ChoiceNode() {
      this.addInput("In", LiteGraph.ACTION);
      this.properties = {
        title: "Path Selection",
        location: "",
        background: "",
        backgroundName: "",
        audioLoop: "",
        audioLoopName: "",
        audioOneShot: "",
        audioOneShotName: "",
        choices: [
          { text: "Fight the Goblin", condition: "", mission: "" },
          { text: "Unlock the hidden gate", condition: "has_item('rusty_key')", mission: "" }
        ]
      };
      this.size = [240, 120];
      this.updateChoiceOutputs();
    }

    ChoiceNode.title = "Choice";
    ChoiceNode.color = "#5b21b6";
    ChoiceNode.bgcolor = "#191d28";

    ChoiceNode.prototype.updateChoiceOutputs = function() {
      const neededOutputs = this.properties.choices.length;
      while (this.outputs && this.outputs.length > neededOutputs) {
        this.removeOutput(this.outputs.length - 1);
      }
      for (let i = 0; i < neededOutputs; i++) {
        const choiceText = this.properties.choices[i].text || `Choice ${i + 1}`;
        const truncated = choiceText.length > 20 ? choiceText.substring(0, 17) + "..." : choiceText;
        if (this.outputs && this.outputs[i]) {
          this.outputs[i].label = truncated;
        } else {
          this.addOutput(truncated, LiteGraph.ACTION);
        }
      }
    };

    ChoiceNode.prototype.onConfigure = function() { this.updateChoiceOutputs(); };

    ChoiceNode.prototype.onDrawForeground = function(ctx) {
      if (this.flags.collapsed) return;
      ctx.font = "10px Inter, sans-serif";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(`Options: ${this.properties.choices.length}`, 12, 45);
      const missionCount = this.properties.choices.filter(c => c.mission).length;
      if (missionCount) {
        ctx.fillStyle = "#fbbf24";
        ctx.fillText(`⚑ ${missionCount} mission accept${missionCount > 1 ? "s" : ""}`, 12, 60);
      }
    };

    LiteGraph.registerNodeType("vnovel/choice", ChoiceNode);

    // C. TRAVERSAL (DICE ROLL) NODE
    function TraversalNode() {
      this.addInput("In", LiteGraph.ACTION);
      this.properties = {
        title: "Dice Maze Challenge",
        location: "",
        background: "",
        backgroundName: "",
        audioLoop: "",
        audioLoopName: "",
        audioOneShot: "",
        audioOneShotName: "",
        targetAccumulation: 100,
        outcomes: [
          { label: "Become Monster", probability: 10, description: "You got bitten by a shadow creature and mutated!" },
          { label: "Spike Trap (Die)", probability: 5, description: "You stepped on a pressure plate and fell into spikes." }
        ]
      };
      this.size = [260, 120];
      this.updateOutputs();
    }

    TraversalNode.title = "Traversal";
    TraversalNode.color = "#92400e";
    TraversalNode.bgcolor = "#191d28";

    // Slot layout: 0 = escape/success, 1..n = risk outcomes, n+1 = early exit
    TraversalNode.prototype.updateOutputs = function() {
      const outcomes = this.properties.outcomes || [];
      const needed = outcomes.length + 2;
      while (this.outputs && this.outputs.length > needed) {
        this.removeOutput(this.outputs.length - 1);
      }
      const ensure = (idx, label) => {
        if (this.outputs && this.outputs[idx]) this.outputs[idx].label = label;
        else this.addOutput(label, LiteGraph.ACTION);
      };
      ensure(0, "\u{1F389} Escape / Success");
      outcomes.forEach((o, i) => ensure(i + 1, o.label || `Outcome ${i + 1}`));
      ensure(outcomes.length + 1, "\u{1F6AA} Early Exit");
    };

    TraversalNode.prototype.onConfigure = function() { this.updateOutputs(); };

    TraversalNode.prototype.onDrawForeground = function(ctx) {
      if (this.flags.collapsed) return;
      ctx.font = "10px Inter, sans-serif";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(`Target Score: ${this.properties.targetAccumulation}`, 12, 45);

      let yOffset = 60;
      (this.properties.outcomes || []).forEach((out) => {
        const chance = out.probability !== undefined ? out.probability : 10;
        ctx.fillText(`• ${out.label}: ${chance}%`, 12, yOffset);
        yOffset += 15;
      });

      const neededHeight = yOffset + 15;
      if (this.size[1] < neededHeight) this.size[1] = neededHeight;
    };

    LiteGraph.registerNodeType("vnovel/traversal", TraversalNode);

    // D. LOGIC GATE NODE
    function LogicGateNode() {
      this.addInput("In", LiteGraph.ACTION);
      this.addOutput("True Path", LiteGraph.ACTION);
      this.addOutput("False Path", LiteGraph.ACTION);

      this.properties = {
        title: "Conditional Gate",
        condition: "has_knowledge('heard_rustle')"
      };

      this.size = [220, 80];
    }

    LogicGateNode.title = "Logic Gate";
    LogicGateNode.color = "#065f46";
    LogicGateNode.bgcolor = "#191d28";

    LogicGateNode.prototype.onDrawForeground = function(ctx) {
      if (this.flags.collapsed) return;
      ctx.font = "10px Inter, sans-serif";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText("Routes by condition", 12, 45);
      let condStr = this.properties.condition || "";
      if (condStr.length > 25) condStr = condStr.substring(0, 22) + "...";
      ctx.fillStyle = "#34d399";
      ctx.fillText(`Check: ${condStr}`, 12, 60);
    };

    LiteGraph.registerNodeType("vnovel/logic_gate", LogicGateNode);
  },

  // ================= UNDO SYSTEM =================

  currentState() {
    return {
      graphSchema: this.graph.serialize(),
      globalVars: this.globalVars,
      varMeta: this.varMeta,
      projectTitle: this.projectTitle,
      bookmarks: this.bookmarks
    };
  },

  snapshotStr() {
    return JSON.stringify(this.currentState());
  },

  initUndo() {
    this._states = [this.snapshotStr()];
    this._statePtr = 0;

    // Also catch canvas-native edits (node drags, link rewires) that don't go
    // through our code — cheap JSON diff on an interval, skipped mid-drag.
    setInterval(() => {
      if (this.gamePlaying || this._restoring) return;
      if (this.canvas && this.canvas.pointer_is_down) return;
      this.checkpoint();
    }, 1200);
  },

  checkpoint() {
    if (this._restoring || !this.graph) return;
    const cur = this.snapshotStr();
    if (this._states[this._statePtr] === cur) return;
    this._states.splice(this._statePtr + 1);
    this._states.push(cur);
    if (this._states.length > 60) this._states.shift();
    this._statePtr = this._states.length - 1;
  },

  undo() {
    this.checkpoint(); // capture any pending edits first
    if (this._statePtr <= 0) { this.toast("Nothing to undo", "warning"); return; }
    this._statePtr--;
    this.restoreState(JSON.parse(this._states[this._statePtr]));
    // Normalize: restoring can shift slot labels etc., keep stack aligned
    this._states[this._statePtr] = this.snapshotStr();
    this.toast("Undo");
  },

  redo() {
    if (this._statePtr >= this._states.length - 1) { this.toast("Nothing to redo", "warning"); return; }
    this._statePtr++;
    this.restoreState(JSON.parse(this._states[this._statePtr]));
    this._states[this._statePtr] = this.snapshotStr();
    this.toast("Redo");
  },

  restoreState(state) {
    this._restoring = true;
    try {
      this.closeInspector();
      if (state.graphSchema) this.graph.configure(state.graphSchema);
      if (state.globalVars) this.globalVars = state.globalVars;
      if (state.varMeta) this.varMeta = state.varMeta;
      if (state.projectTitle) this.setProjectTitle(state.projectTitle);
      this.ensureVarShape();
      this.renderGlobalTags();
      this.renderBookmarks();
      this.canvas.draw(true, true);
      this.saveToLocalStorage();
    } finally {
      this._restoring = false;
    }
  },

  // Debounced persist used by live-apply inspector fields
  schedulePersist() {
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this.saveToLocalStorage();
      this.checkpoint();
      this.renderBookmarks();
    }, 600);
  },

  ensureVarShape() {
    ["characters", "locations", "collectibles", "knowledge", "missions"].forEach(k => {
      if (!Array.isArray(this.globalVars[k])) this.globalVars[k] = [];
    });
    if (!this.varMeta || typeof this.varMeta !== "object") this.varMeta = {};
  },

  getMeta(category, name) {
    if (!this.varMeta[category]) this.varMeta[category] = {};
    if (!this.varMeta[category][name]) this.varMeta[category][name] = {};
    return this.varMeta[category][name];
  },

  setProjectTitle(title) {
    this.projectTitle = title || "Untitled Story";
    const input = document.getElementById("project_title_input");
    if (input && input.value !== this.projectTitle) input.value = this.projectTitle;
  },

  // ================= UI PANELS =================

  initUI() {
    this.renderGlobalTags();
    this.renderBookmarks();
    this.closeInspector();
    this.updateLLMModels();
  },

  renderGlobalTags() {
    const listContainer = document.getElementById("global_vars_list");
    if (!listContainer) return;
    listContainer.innerHTML = "";

    this.VAR_CATEGORIES.forEach(cat => {
      const section = document.createElement("div");
      section.className = "list-section";
      section.innerHTML = `
        <div class="section-title">
          <span>${cat.label}</span>
          <button class="section-add-btn" title="Add ${cat.singular}"><i class="fas fa-plus"></i></button>
        </div>
        <div class="inline-add-row">
          <input type="text" placeholder="New ${cat.singular} name...">
          <button class="btn" style="padding:4px 10px; font-size:11px;">Add</button>
        </div>
        <div class="tag-list"></div>
      `;
      listContainer.appendChild(section);

      const addRow = section.querySelector(".inline-add-row");
      const addInput = addRow.querySelector("input");
      const commit = () => {
        const val = addInput.value.trim();
        if (val) this.addVariable(cat.key, val);
        addInput.value = "";
        addRow.classList.remove("open");
      };
      section.querySelector(".section-add-btn").onclick = () => {
        addRow.classList.toggle("open");
        if (addRow.classList.contains("open")) addInput.focus();
      };
      addRow.querySelector(".btn").onclick = commit;
      addInput.onkeydown = (e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") addRow.classList.remove("open");
      };

      const tagContainer = section.querySelector(".tag-list");
      (this.globalVars[cat.key] || []).forEach(val => {
        const meta = (this.varMeta[cat.key] && this.varMeta[cat.key][val]) || {};
        const tag = document.createElement("span");
        tag.className = `variable-tag ${cat.cssClass}`;
        tag.title = (meta.info ? meta.info + "\n\n" : "") + "Double-click to edit background info";
        tag.innerHTML = `
          ${meta.info ? '<span class="has-info-dot"></span>' : ""}
          ${cat.key === "missions" && meta.required ? '<i class="fas fa-exclamation-circle" style="font-size:9px;"></i>' : ""}
          ${this.escapeHtml(val)}
          <span class="remove-tag">&times;</span>
        `;
        tag.querySelector(".remove-tag").onclick = (e) => {
          e.stopPropagation();
          this.removeVariable(cat.key, val);
        };
        tag.ondblclick = () => this.openItemModal(cat.key, val);
        tagContainer.appendChild(tag);
      });
    });
  },

  addVariable(category, name) {
    if (!this.globalVars[category].includes(name)) {
      this.globalVars[category].push(name);
      this.renderGlobalTags();
      this.updateInspectorAutocompletes();
      this.saveToLocalStorage();
      this.checkpoint();
      this.toast(`Added "${name}" to ${category}`, "success");
    }
  },

  removeVariable(category, name) {
    this.globalVars[category] = this.globalVars[category].filter(v => v !== name);
    if (this.varMeta[category]) delete this.varMeta[category][name];
    this.renderGlobalTags();
    this.updateInspectorAutocompletes();
    this.saveToLocalStorage();
    this.checkpoint();
  },

  // Item background-info modal (double-click a sidebar tag)
  openItemModal(category, name) {
    this.stopAudioPreview();
    this._itemModalTarget = { category, name };
    const meta = this.getMeta(category, name);
    const catDef = this.VAR_CATEGORIES.find(c => c.key === category);
    document.getElementById("item_modal_title").innerHTML =
      `<i class="fas fa-feather"></i> ${this.escapeHtml(name)} <span style="font-size:11px; color:var(--text-dark); font-weight:400;">(${catDef ? catDef.singular : category})</span>`;
    document.getElementById("item_modal_info").value = meta.info || "";
    
    const reqGroup = document.getElementById("item_modal_required_group");
    reqGroup.style.display = category === "missions" ? "flex" : "none";
    document.getElementById("item_modal_required").checked = !!meta.required;

    // Show/Hide Location vs Character meta panels
    const locPanel = document.getElementById("item_modal_location_fields");
    const charPanel = document.getElementById("item_modal_character_fields");
    locPanel.style.display = category === "locations" ? "flex" : "none";
    charPanel.style.display = category === "characters" ? "flex" : "none";

    if (category === "locations") {
      document.getElementById("item_modal_loc_bg").value = meta.background || "";
      document.getElementById("item_modal_loc_music").value = meta.audioLoop || "";

      document.getElementById("item_modal_loc_bg_pick").onclick = () => {
        this.pickFile("image/*", (val, file) => {
          document.getElementById("item_modal_loc_bg").value = val;
          meta.background = val;
          meta.backgroundName = file.name;
        });
      };
      document.getElementById("item_modal_loc_bg_clear").onclick = () => {
        document.getElementById("item_modal_loc_bg").value = "";
        meta.background = "";
        meta.backgroundName = "";
      };

      document.getElementById("item_modal_loc_music_pick").onclick = () => {
        this.pickFile("audio/*", (val, file) => {
          document.getElementById("item_modal_loc_music").value = val;
          meta.audioLoop = val;
          meta.audioLoopName = file.name;
        });
      };
      document.getElementById("item_modal_loc_music_play").onclick = () => {
        this.toggleAudioPreview(document.getElementById("item_modal_loc_music").value, document.getElementById("item_modal_loc_music_play"), true);
      };

      document.getElementById("btn_propagate_location").onclick = () => {
        meta.background = document.getElementById("item_modal_loc_bg").value;
        meta.audioLoop = document.getElementById("item_modal_loc_music").value;
        let count = 0;
        const nodesList = this.graph._nodes || [];
        nodesList.forEach(node => {
          if (node.properties && node.properties.location === name) {
            node.properties.background = meta.background;
            node.properties.backgroundName = meta.backgroundName || "";
            node.properties.audioLoop = meta.audioLoop;
            node.properties.audioLoopName = meta.audioLoopName || "";
            node.setDirtyCanvas(true, true);
            count++;
          }
        });
        this.saveToLocalStorage();
        this.checkpoint();
        this.toast(`Populated ${count} nodes with location background and music!`, "success");
      };
    }

    if (category === "characters") {
      document.getElementById("item_modal_char_img").value = meta.image || "";
      const updateCharPreview = () => {
        const img = document.getElementById("item_modal_char_img").value.trim();
        const preview = document.getElementById("item_modal_char_img_preview");
        if (img) {
          preview.style.backgroundImage = `url("${img}")`;
          preview.textContent = "";
        } else {
          preview.style.backgroundImage = "";
          preview.textContent = "No image set";
        }
      };
      updateCharPreview();

      document.getElementById("item_modal_char_img_pick").onclick = () => {
        this.pickFile("image/*", (val, file) => {
          document.getElementById("item_modal_char_img").value = val;
          meta.image = val;
          meta.imageName = file.name;
          updateCharPreview();
        });
      };
      document.getElementById("item_modal_char_img_clear").onclick = () => {
        document.getElementById("item_modal_char_img").value = "";
        meta.image = "";
        meta.imageName = "";
        updateCharPreview();
      };
      document.getElementById("item_modal_char_img").oninput = updateCharPreview;
    }

    this.openModal("item_modal_overlay");
    document.getElementById("item_modal_info").focus();
  },

  saveItemModal() {
    if (!this._itemModalTarget) return;
    const { category, name } = this._itemModalTarget;
    const meta = this.getMeta(category, name);
    meta.info = document.getElementById("item_modal_info").value;
    if (category === "missions") {
      meta.required = document.getElementById("item_modal_required").checked;
    }
    if (category === "locations") {
      meta.background = document.getElementById("item_modal_loc_bg").value;
      meta.audioLoop = document.getElementById("item_modal_loc_music").value;
    }
    if (category === "characters") {
      meta.image = document.getElementById("item_modal_char_img").value;
    }
    this.closeModal("item_modal_overlay");
    this.renderGlobalTags();
    this.saveToLocalStorage();
    this.checkpoint();
    this.toast(`Details saved for "${name}"`, "success");
  },

  ensureBookmarksMigrated() {
    if (!this.bookmarks) this.bookmarks = [];
    const nodesList = this.graph._nodes || [];
    nodesList.forEach(node => {
      if (node.properties && node.properties.isChapterStart) {
        const alreadyExists = this.bookmarks.some(bm => bm.nodeId === node.id);
        if (!alreadyExists) {
          this.bookmarks.push({
            id: "bm_migrated_" + node.id + "_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
            nodeId: node.id,
            name: node.properties.title || `Chapter Node #${node.id}`,
            location: node.properties.location || "Unknown Location",
            startState: {
              inventory: [],
              knowledge: [],
              missions: {}
            }
          });
        }
        delete node.properties.isChapterStart;
      }
    });
  },

  renderBookmarks() {
    const container = document.getElementById("bookmarks_list");
    if (!container) return;
    container.innerHTML = "";

    this.ensureBookmarksMigrated();

    if (!this.bookmarks || this.bookmarks.length === 0) {
      container.innerHTML = `<div style="font-size:12px; color:var(--text-dark); font-style:italic;">No bookmarks defined. Select a node and click the "Bookmark" button in the inspector to create one.</div>`;
      return;
    }

    this.bookmarks.forEach(bm => {
      const el = document.createElement("div");
      el.className = "bookmark-item";
      el.style.display = "flex";
      el.style.justifyContent = "space-between";
      el.style.alignItems = "center";
      el.innerHTML = `
        <div style="flex:1; cursor:pointer;">
          <strong>${this.escapeHtml(bm.name)}</strong>
          <div style="font-size:10px; color:var(--text-dark); margin-top:2px;">Node #${bm.nodeId} &bull; ${this.escapeHtml(bm.location || "Unknown")}</div>
        </div>
        <button class="btn btn-primary btn-play-bm" style="padding: 4px 8px; font-size:10px; background:linear-gradient(135deg, var(--accent-primary), var(--accent-success)); color:white;" title="Play starting from here"><i class="fas fa-play"></i></button>
      `;

      el.onclick = (e) => {
        if (e.target.closest(".btn-play-bm")) return;
        const node = this.graph.getNodeById(bm.nodeId);
        if (node) {
          this.canvas.centerOnNode(node);
          this.canvas.selectNode(node);
          this.openInspector(node);
        }
      };

      el.ondblclick = (e) => {
        if (e.target.closest(".btn-play-bm")) return;
        this.openBookmarkConfigModal(bm);
      };

      el.querySelector(".btn-play-bm").onclick = (e) => {
        e.stopPropagation();
        this.openBookmarkConfigModal(bm);
      };

      container.appendChild(el);
    });
  },

  createBookmark(node) {
    const bookmark = {
      id: "bm_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
      nodeId: node.id,
      name: node.properties.title || `Bookmark for Node #${node.id}`,
      location: node.properties.location || "Unknown Location",
      startState: {
        inventory: [],
        knowledge: [],
        missions: {}
      }
    };
    if (!this.bookmarks) this.bookmarks = [];
    this.bookmarks.push(bookmark);
    this.renderBookmarks();
    this.saveToLocalStorage();
    this.toast("Bookmark created! Double-click it in the sidebar to configure starting state.", "success");
  },

  openBookmarkConfigModal(bm) {
    document.getElementById("bm_config_name").value = bm.name || "";
    
    // Inventory
    const invContainer = document.getElementById("bm_config_inventory");
    invContainer.innerHTML = "";
    if (this.globalVars.collectibles.length === 0) {
      invContainer.innerHTML = `<div style="font-size:11px; color:var(--text-dark); font-style:italic;">No collectibles defined in Globals.</div>`;
    } else {
      this.globalVars.collectibles.forEach(item => {
        const checked = bm.startState && bm.startState.inventory && bm.startState.inventory.includes(item) ? "checked" : "";
        const label = document.createElement("label");
        label.style.display = "flex";
        label.style.alignItems = "center";
        label.style.gap = "8px";
        label.style.cursor = "pointer";
        label.innerHTML = `<input type="checkbox" class="bm-inv-check" value="${this.escapeHtml(item)}" ${checked}> ${this.escapeHtml(item)}`;
        invContainer.appendChild(label);
      });
    }

    // Knowledge
    const knowContainer = document.getElementById("bm_config_knowledge");
    knowContainer.innerHTML = "";
    if (this.globalVars.knowledge.length === 0) {
      knowContainer.innerHTML = `<div style="font-size:11px; color:var(--text-dark); font-style:italic;">No knowledge flags defined in Globals.</div>`;
    } else {
      this.globalVars.knowledge.forEach(kw => {
        const checked = bm.startState && bm.startState.knowledge && bm.startState.knowledge.includes(kw) ? "checked" : "";
        const label = document.createElement("label");
        label.style.display = "flex";
        label.style.alignItems = "center";
        label.style.gap = "8px";
        label.style.cursor = "pointer";
        label.innerHTML = `<input type="checkbox" class="bm-know-check" value="${this.escapeHtml(kw)}" ${checked}> ${this.escapeHtml(kw)}`;
        knowContainer.appendChild(label);
      });
    }

    // Missions
    const missContainer = document.getElementById("bm_config_missions");
    missContainer.innerHTML = "";
    if (this.globalVars.missions.length === 0) {
      missContainer.innerHTML = `<div style="font-size:11px; color:var(--text-dark); font-style:italic;">No missions defined in Globals.</div>`;
    } else {
      this.globalVars.missions.forEach(m => {
        const status = bm.startState && bm.startState.missions && bm.startState.missions[m] ? bm.startState.missions[m] : "none";
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "center";
        row.innerHTML = `
          <span style="font-size:12px;">${this.escapeHtml(m)}</span>
          <select class="select-input bm-mission-select" data-mission="${this.escapeHtml(m)}" style="width:120px; padding:3px 6px; font-size:11px;">
            <option value="none" ${status === "none" ? "selected" : ""}>Inactive</option>
            <option value="active" ${status === "active" ? "selected" : ""}>Active</option>
            <option value="done" ${status === "done" ? "selected" : ""}>Completed</option>
          </select>
        `;
        missContainer.appendChild(row);
      });
    }

    // Save and play click
    document.getElementById("btn_play_bookmark").onclick = () => {
      // Save name
      bm.name = document.getElementById("bm_config_name").value.trim() || `Bookmark for Node #${bm.nodeId}`;
      
      // Save startState
      bm.startState = {
        inventory: Array.from(invContainer.querySelectorAll(".bm-inv-check:checked")).map(el => el.value),
        knowledge: Array.from(knowContainer.querySelectorAll(".bm-know-check:checked")).map(el => el.value),
        missions: {}
      };
      missContainer.querySelectorAll(".bm-mission-select").forEach(sel => {
        const mName = sel.dataset.mission;
        const val = sel.value;
        if (val !== "none") {
          bm.startState.missions[mName] = val;
        }
      });

      this.saveToLocalStorage();
      this.renderBookmarks();
      this.closeModal("bookmark_modal_overlay");
      
      // Play!
      const startNode = this.graph.getNodeById(bm.nodeId);
      if (!startNode) {
        this.toast(`Node #${bm.nodeId} no longer exists. Playback failed.`, "danger");
        return;
      }
      this.startPlayback(startNode, bm.startState);
    };

    // Delete bookmark click
    document.getElementById("btn_delete_bookmark").onclick = () => {
      this.bookmarks = this.bookmarks.filter(x => x.id !== bm.id);
      this.saveToLocalStorage();
      this.renderBookmarks();
      this.closeModal("bookmark_modal_overlay");
      this.toast("Bookmark deleted", "success");
    };

    this.openModal("bookmark_modal_overlay");
  },

  // ================= INSPECTOR (live-apply, no save buttons) =================

  openInspector(node) {
    this.stopAudioPreview();
    this.activeNode = node;
    const drawer = document.getElementById("inspector_drawer");
    const container = document.getElementById("inspector_content");
    drawer.classList.remove("collapsed");
    container.innerHTML = "";

    const typeNames = {
      "vnovel/passthrough": "Dialogue Scene",
      "vnovel/choice": "Choice Branch",
      "vnovel/traversal": "Traversal Challenge",
      "vnovel/logic_gate": "Logic Gate"
    };

    const nodeHeader = document.createElement("div");
    nodeHeader.style.marginBottom = "15px";
    nodeHeader.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
        <div>
          <h3 style="font-family:var(--font-display); font-size:16px; margin-bottom:4px;">${typeNames[node.type] || "Node"}</h3>
          <span style="font-size:11px; color:var(--accent-primary); text-transform:uppercase; font-weight:600;">#${node.id}</span>
        </div>
        <div style="display:flex; gap:6px;">
          <button class="btn" id="btn_create_bookmark" style="padding: 6px 10px; font-size: 11px; border: 1px solid var(--accent-info); color: var(--accent-info); background: transparent;">
            <i class="fas fa-bookmark" style="font-size: 10px;"></i> Bookmark
          </button>
          <button class="btn btn-primary" id="btn_play_from_here" style="padding: 6px 12px; font-size: 11px; background: linear-gradient(135deg, var(--accent-primary), var(--accent-success));">
            <i class="fas fa-play" style="font-size: 10px;"></i> Play
          </button>
        </div>
      </div>
    `;
    container.appendChild(nodeHeader);
    nodeHeader.querySelector("#btn_play_from_here").onclick = () => this.startPlayback(node);
    nodeHeader.querySelector("#btn_create_bookmark").onclick = () => this.createBookmark(node);

    if (node.type === "vnovel/passthrough") {
      this.renderPassthroughInspector(node, container);
    } else if (node.type === "vnovel/choice") {
      this.renderChoiceInspector(node, container);
    } else if (node.type === "vnovel/traversal") {
      this.renderTraversalInspector(node, container);
    } else if (node.type === "vnovel/logic_gate") {
      this.renderLogicGateInspector(node, container);
    }
  },

  closeInspector() {
    this.stopAudioPreview();
    this.activeNode = null;
    const drawer = document.getElementById("inspector_drawer");
    if (drawer) drawer.classList.add("collapsed");
  },

  // Live-apply helper: writes to node property on every keystroke, then
  // debounces persistence + undo checkpoint.
  bindLive(el, node, apply, evt = "input") {
    el.addEventListener(evt, () => {
      apply(el);
      node.setDirtyCanvas(true, true);
      this.schedulePersist();
    });
  },

  // DIALOGUE INSPECTOR
  renderPassthroughInspector(node, container) {
    const p = node.properties;
    const form = document.createElement("div");
    form.className = "inspector-scroll";
    form.style.padding = "0";

    const locOptions = this.globalVars.locations.map(loc =>
      `<option value="${this.escapeHtml(loc)}" ${p.location === loc ? "selected" : ""}>${this.escapeHtml(loc)}</option>`).join("");
    const missionOptions = (sel) => `<option value="">None</option>` + this.globalVars.missions.map(m =>
      `<option value="${this.escapeHtml(m)}" ${sel === m ? "selected" : ""}>${this.escapeHtml(m)}</option>`).join("");

    form.innerHTML = `
      <div class="form-group">
        <label>Node Title</label>
        <input type="text" class="input-text" id="insp_title" value="${this.escapeHtml(p.title || "")}">
      </div>



      <div class="form-group">
        <label>Location</label>
        <div style="display:flex; gap:6px; align-items:center;">
          <select class="select-input" id="insp_location" style="flex:1;">
            ${locOptions}
            <option value="__add__">＋ Add new location…</option>
          </select>
          <button class="btn btn-primary" id="btn_populate_from_global" style="padding:7px 12px; font-size:11px;" title="Populate background and music from the selected location's global settings">
            <i class="fas fa-sync-alt"></i> Populate from Globals
          </button>
        </div>
        <div id="insp_new_loc_row" style="display:none; gap:6px; margin-top:4px;">
          <input type="text" class="input-text" id="insp_new_loc" placeholder="New location name — press Enter">
        </div>
      <div class="form-group">
        <div style="display:flex; align-items:center; gap:10px;">
          <input type="checkbox" id="insp_show_char_img" ${p.showCharacterImages !== false ? "checked" : ""} style="width:16px; height:16px; cursor:pointer;">
          <label style="cursor:pointer;" for="insp_show_char_img">Show character PNG images during dialogues</label>
        </div>
      </div>

      <div class="form-group">
        <label>Dialogue / Action Text</label>
        <div class="editor-container">
          <textarea class="textarea-input dialogue-textarea" id="insp_text" placeholder="Hero: Did you hear that?&#10;The wind rustles. (no name = narration)">${this.escapeHtml(p.text || "")}</textarea>
          <div class="autocomplete-menu" id="autocomplete_menu"></div>
        </div>
        <div class="field-hint">
          One line = one beat. Start a line with <code>Name:</code> to show the speaker above the box —
          the colon is added automatically for known characters. Type <code>{</code> for autocomplete.
        </div>
        <div class="quick-add-bubble" id="speaker_bubble"></div>
        <label style="margin-top:6px;">Preview:</label>
        <div class="highlight-helper" id="highlight_helper"></div>
      </div>

      <div class="form-group">
        <label>Background Image</label>
        <div class="bg-preview" id="insp_bg_preview">No background set</div>
        <div class="file-pick-row">
          <input type="text" class="input-text" id="insp_bg" value="${this.escapeHtml(p.background || "")}" placeholder="URL, or pick a file →">
          <button class="btn file-pick-btn" id="insp_bg_pick"><i class="fas fa-folder-open"></i></button>
          <button class="btn file-pick-btn" id="insp_bg_clear" title="Clear"><i class="fas fa-times"></i></button>
        </div>
      </div>

      <div class="form-group">
        <label>Music Loop <span style="color:var(--text-dark);">(crossfades between scenes)</span></label>
        <div class="audio-row">
          <input type="text" class="input-text" id="insp_audio_loop" value="${this.escapeHtml(p.audioLoop || "")}" placeholder="URL, or pick a file →">
          <button class="btn file-pick-btn" id="insp_audio_loop_pick"><i class="fas fa-folder-open"></i></button>
          <button class="btn audio-preview-btn" id="insp_audio_loop_play" title="Preview loop"><i class="fas fa-play"></i></button>
        </div>
      </div>

      <div class="form-group">
        <label>One-Shot Sound <span style="color:var(--text-dark);">(plays once on scene enter)</span></label>
        <div class="audio-row">
          <input type="text" class="input-text" id="insp_audio_shot" value="${this.escapeHtml(p.audioOneShot || "")}" placeholder="URL, or pick a file →">
          <button class="btn file-pick-btn" id="insp_audio_shot_pick"><i class="fas fa-folder-open"></i></button>
          <button class="btn audio-preview-btn" id="insp_audio_shot_play" title="Preview one-shot"><i class="fas fa-play"></i></button>
        </div>
      </div>

      <div class="form-group" style="border-top:1px solid var(--border-color); padding-top:15px; margin-top:10px;">
        <label style="font-weight:600; color:var(--accent-info);">Rewards & Missions</label>
      </div>

      <div class="form-group">
        <label>Add Item to Inventory</label>
        <select class="select-input" id="insp_reward_item">
          <option value="">None</option>
          ${this.globalVars.collectibles.map(item => `<option value="${this.escapeHtml(item)}" ${p.rewardItems === item ? "selected" : ""}>${this.escapeHtml(item)}</option>`).join("")}
        </select>
      </div>

      <div class="form-group">
        <label>Unlock Knowledge (Diary Page)</label>
        <select class="select-input" id="insp_reward_knowledge">
          <option value="">None</option>
          ${this.globalVars.knowledge.map(kw => `<option value="${this.escapeHtml(kw)}" ${p.rewardKnowledge === kw ? "selected" : ""}>${this.escapeHtml(kw)}</option>`).join("")}
        </select>
      </div>

      <div class="form-group">
        <label>Start Mission on Enter</label>
        <select class="select-input" id="insp_start_mission">${missionOptions(p.startMission)}</select>
      </div>

      <div class="form-group">
        <label>Complete Mission on Enter</label>
        <select class="select-input" id="insp_complete_mission">${missionOptions(p.completeMission)}</select>
      </div>

      <div style="margin-top:10px; display:flex; gap:10px;">
        <button class="btn btn-success" style="flex:1; justify-content:center;" id="btn_llm_expand_node" title="Ask LLM to expand dialogue content"><i class="fas fa-magic"></i> Expand Dialogue with LLM</button>
      </div>
    `;
    container.appendChild(form);

    const $ = id => form.querySelector("#" + id);

    // --- Live bindings ---
    this.bindLive($("insp_title"), node, el => {
      p.title = el.value;
      node.title = el.value || "Dialogue";
    });

    this.bindLive($("insp_show_char_img"), node, el => {
      p.showCharacterImages = el.checked;
    }, "change");

    this.bindLive($("insp_reward_item"), node, el => { p.rewardItems = el.value; }, "change");
    this.bindLive($("insp_reward_knowledge"), node, el => { p.rewardKnowledge = el.value; }, "change");
    this.bindLive($("insp_start_mission"), node, el => { p.startMission = el.value; }, "change");
    this.bindLive($("insp_complete_mission"), node, el => { p.completeMission = el.value; }, "change");

    // Location select with inline "add new"
    this.wireLocationField(node, form, p);

    // Dialogue text: live apply + highlight + auto-colon on blur + unknown speakers
    const textArea = $("insp_text");
    this.bindLive(textArea, node, el => { p.text = el.value; });
    this.setupAutocomplete("insp_text", "autocomplete_menu");
    this.setupDialogueHighlight("insp_text", "highlight_helper");
    this.setupSpeakerQuickAdd(textArea, $("speaker_bubble"));
    textArea.addEventListener("blur", () => {
      const normalized = this.normalizeDialogueText(textArea.value);
      if (normalized !== textArea.value) {
        textArea.value = normalized;
        p.text = normalized;
        textArea.dispatchEvent(new Event("input"));
        this.toast("Added missing colons after character names", "success");
      }
    });

    // Background image
    this.wireBackgroundField(node, $("insp_bg"), $("insp_bg_preview"), $("insp_bg_pick"), $("insp_bg_clear"));

    // Audio fields (loop + one-shot), each with file pick and preview
    this.wireAudioField(node, $("insp_audio_loop"), $("insp_audio_loop_pick"), $("insp_audio_loop_play"), "audioLoop", "audioLoopName", true);
    this.wireAudioField(node, $("insp_audio_shot"), $("insp_audio_shot_pick"), $("insp_audio_shot_play"), "audioOneShot", "audioOneShotName", false);

    $("btn_llm_expand_node").onclick = () => this.triggerLLMExpansion(node);
  },

  wireLocationField(node, form, p) {
    const $ = id => form.querySelector("#" + id);
    const locSelect = $("insp_location");
    const newLocRow = $("insp_new_loc_row");
    const newLocInput = $("insp_new_loc");
    
    if (locSelect) {
      locSelect.addEventListener("change", () => {
        if (locSelect.value === "__add__") {
          newLocRow.style.display = "flex";
          newLocInput.focus();
          return;
        }
        p.location = locSelect.value;
        node.setDirtyCanvas(true, true);
        this.schedulePersist();
      });
    }

    if (newLocInput) {
      newLocInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          const val = newLocInput.value.trim();
          if (val) {
            this.addVariable("locations", val);
            p.location = val;
            this.openInspector(node); // re-render to refresh the select
          }
        } else if (e.key === "Escape") {
          newLocRow.style.display = "none";
          locSelect.value = p.location || "";
        }
      });
    }

    const popBtn = $("btn_populate_from_global");
    if (popBtn) {
      popBtn.onclick = () => {
        const locName = locSelect.value;
        if (!locName || locName === "__add__") {
          this.toast("Select a valid location first", "warning");
          return;
        }
        const meta = this.getMeta("locations", locName);
        p.background = meta.background || "";
        p.backgroundName = meta.backgroundName || "";
        p.audioLoop = meta.audioLoop || "";
        p.audioLoopName = meta.audioLoopName || "";
        
        // Refresh text inputs if present on screen
        const bgInput = $("insp_bg");
        if (bgInput) {
          bgInput.value = p.background;
          bgInput.dispatchEvent(new Event("input"));
        }
        const musicInput = $("insp_audio_loop");
        if (musicInput) {
          musicInput.value = p.audioLoop;
          musicInput.dispatchEvent(new Event("input"));
        }
        
        node.setDirtyCanvas(true, true);
        this.schedulePersist();
        this.toast(`Populated background and music from global location "${locName}"!`, "success");
      };
    }
  },

  wireBackgroundField(node, input, preview, pickBtn, clearBtn) {
    const p = node.properties;
    const refreshBgPreview = () => {
      const v = (p.background || "").trim();
      if (!v) {
        preview.style.backgroundImage = "";
        preview.textContent = "No background set";
      } else if (v.includes("gradient(")) {
        preview.style.backgroundImage = v;
        preview.textContent = "";
      } else {
        preview.style.backgroundImage = `url("${v.replace(/"/g, '%22')}")`;
        preview.textContent = "";
      }
    };
    refreshBgPreview();
    this.bindLive(input, node, el => {
      p.background = el.value;
      p.backgroundName = "";
      refreshBgPreview();
    });
    pickBtn.onclick = () => {
      this.pickFile("image/*", (value, file, embedded) => {
        p.background = value;
        p.backgroundName = file.name;
        if (embedded) {
          input.value = "";
          input.placeholder = `embedded: ${file.name}`;
        } else {
          input.value = value;
          input.placeholder = "URL, or pick a file →";
        }
        refreshBgPreview();
        node.setDirtyCanvas(true, true);
        this.schedulePersist();
      });
    };
    clearBtn.onclick = () => {
      p.background = ""; p.backgroundName = "";
      input.value = ""; input.placeholder = "URL, or pick a file →";
      refreshBgPreview();
      node.setDirtyCanvas(true, true);
      this.schedulePersist();
    };
    if (p.background && p.background.startsWith("data:")) {
      input.value = "";
      input.placeholder = `embedded: ${p.backgroundName || "image file"}`;
    }
  },

  wireAudioField(node, input, pickBtn, playBtn, propKey, nameKey, loop) {
    const p = node.properties;
    if (p[propKey] && p[propKey].startsWith("data:")) {
      input.value = "";
      input.placeholder = `embedded: ${p[nameKey] || "audio file"}`;
    }
    this.bindLive(input, node, el => {
      p[propKey] = el.value;
      p[nameKey] = "";
    });
    pickBtn.onclick = () => {
      this.pickFile("audio/*", (value, file, embedded) => {
        p[propKey] = value;
        p[nameKey] = file.name;
        if (embedded) {
          input.value = "";
          input.placeholder = `embedded: ${file.name}`;
        } else {
          input.value = value;
          input.placeholder = "URL, or pick a file →";
        }
        node.setDirtyCanvas(true, true);
        this.schedulePersist();
      });
    };
    playBtn.onclick = () => this.toggleAudioPreview(p[propKey], playBtn, loop);
  },

  toggleAudioPreview(src, btn, loop) {
    // Toggle off if this button is currently playing
    if (this._previewBtn === btn && this._previewAudio) {
      this.stopAudioPreview();
      return;
    }
    this.stopAudioPreview();
    if (!src || !src.trim()) {
      this.toast("No audio set on this field yet", "warning");
      return;
    }
    const a = new Audio(src);
    a.loop = !!loop;
    const played = a.play();
    if (played && played.catch) {
      played.catch(() => this.toast("Couldn't play that audio source", "danger"));
    }
    a.onended = () => { if (this._previewAudio === a) this.stopAudioPreview(); };
    this._previewAudio = a;
    this._previewBtn = btn;
    btn.classList.add("playing");
    btn.innerHTML = '<i class="fas fa-stop"></i>';
  },

  stopAudioPreview() {
    if (this._previewAudio) {
      this._previewAudio.pause();
      this._previewAudio.src = "";
      this._previewAudio = null;
    }
    if (this._previewBtn) {
      this._previewBtn.classList.remove("playing");
      this._previewBtn.innerHTML = '<i class="fas fa-play"></i>';
      this._previewBtn = null;
    }
  },

  getAssetMode() {
    return localStorage.getItem("vnovel_asset_mode") || "embed";
  },

  // cb(value, file, embedded) — value is either a base64 data URL (embed mode)
  // or an "assets/<filename>" relative path (reference mode).
  pickFile(accept, cb) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return;

      if (this.getAssetMode() === "reference") {
        const path = "assets/" + file.name;
        this.toast(`Referenced as "${path}" — keep the file in an assets folder next to this editor and next to any published HTML.`, "success");
        cb(path, file, false);
        return;
      }

      if (file.size > 3 * 1024 * 1024) {
        this.toast("Heads up: large embedded files can exceed browser save limits. Consider switching to 'Reference by path' in the sidebar, or use a URL.", "warning");
      }
      const reader = new FileReader();
      reader.onload = () => cb(reader.result, file, true);
      reader.readAsDataURL(file);
    };
    input.click();
  },

  // CHOICE INSPECTOR
  renderChoiceInspector(node, container) {
    const p = node.properties;
    const form = document.createElement("div");
    form.className = "inspector-scroll";
    form.style.padding = "0";

    const locOptions = this.globalVars.locations.map(loc =>
      `<option value="${this.escapeHtml(loc)}" ${p.location === loc ? "selected" : ""}>${this.escapeHtml(loc)}</option>`).join("");

    form.innerHTML = `
      <div class="form-group">
        <label>Prompt shown to the player</label>
        <input type="text" class="input-text serif-text" id="insp_title" value="${this.escapeHtml(p.title || "")}">
      </div>

      <div class="form-group">
        <label>Location</label>
        <div style="display:flex; gap:6px; align-items:center;">
          <select class="select-input" id="insp_location" style="flex:1;">
            ${locOptions}
            <option value="__add__">＋ Add new location…</option>
          </select>
          <button class="btn btn-primary" id="btn_populate_from_global" style="padding:7px 12px; font-size:11px;" title="Populate background and music from the selected location's global settings">
            <i class="fas fa-sync-alt"></i> Populate from Globals
          </button>
        </div>
        <div id="insp_new_loc_row" style="display:none; gap:6px; margin-top:4px;">
          <input type="text" class="input-text" id="insp_new_loc" placeholder="New location name — press Enter">
        </div>
      </div>

      <div class="form-group">
        <label>Background Image</label>
        <div class="bg-preview" id="insp_bg_preview">No background set</div>
        <div class="file-pick-row">
          <input type="text" class="input-text" id="insp_bg" value="${this.escapeHtml(p.background || "")}" placeholder="URL, or pick a file →">
          <button class="btn file-pick-btn" id="insp_bg_pick"><i class="fas fa-folder-open"></i></button>
          <button class="btn file-pick-btn" id="insp_bg_clear" title="Clear"><i class="fas fa-times"></i></button>
        </div>
      </div>

      <div class="form-group">
        <label>Music Loop <span style="color:var(--text-dark);">(crossfades between scenes)</span></label>
        <div class="audio-row">
          <input type="text" class="input-text" id="insp_audio_loop" value="${this.escapeHtml(p.audioLoop || "")}" placeholder="URL, or pick a file →">
          <button class="btn file-pick-btn" id="insp_audio_loop_pick"><i class="fas fa-folder-open"></i></button>
          <button class="btn audio-preview-btn" id="insp_audio_loop_play" title="Preview loop"><i class="fas fa-play"></i></button>
        </div>
      </div>

      <div class="form-group">
        <label>One-Shot Sound <span style="color:var(--text-dark);">(plays once on scene enter)</span></label>
        <div class="audio-row">
          <input type="text" class="input-text" id="insp_audio_shot" value="${this.escapeHtml(p.audioOneShot || "")}" placeholder="URL, or pick a file →">
          <button class="btn file-pick-btn" id="insp_audio_shot_pick"><i class="fas fa-folder-open"></i></button>
          <button class="btn audio-preview-btn" id="insp_audio_shot_play" title="Preview one-shot"><i class="fas fa-play"></i></button>
        </div>
      </div>

      <div class="form-group">
        <label style="font-weight:600; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
          Choice branches
          <button class="btn btn-success" style="padding:2px 8px; font-size:11px;" id="btn_add_choice_item">+ Add Option</button>
        </label>
        <div id="choices_rows_container"></div>
        <div class="field-hint">Each option gets its own output on the node. Attach a mission to an option and choosing it accepts the mission (it appears in the player's HUD).</div>
      </div>
    `;
    container.appendChild(form);

    const $ = id => form.querySelector("#" + id);

    this.bindLive($("insp_title"), node, el => {
      p.title = el.value;
      node.title = el.value || "Path Selection";
    });

    this.wireLocationField(node, form, p);
    this.wireBackgroundField(node, $("insp_bg"), $("insp_bg_preview"), $("insp_bg_pick"), $("insp_bg_clear"));
    this.wireAudioField(node, $("insp_audio_loop"), $("insp_audio_loop_pick"), $("insp_audio_loop_play"), "audioLoop", "audioLoopName", true);
    this.wireAudioField(node, $("insp_audio_shot"), $("insp_audio_shot_pick"), $("insp_audio_shot_play"), "audioOneShot", "audioOneShotName", false);

    const rowsContainer = form.querySelector("#choices_rows_container");

    const renderChoicesRows = () => {
      rowsContainer.innerHTML = "";
      p.choices.forEach((choice, idx) => {
        if (choice.mission === undefined) choice.mission = "";
        const row = document.createElement("div");
        row.className = "outcome-row";
        row.innerHTML = `
          <div class="outcome-row-header">
            <span style="font-size:12px; font-weight:600; color:var(--accent-secondary);">Option #${idx + 1}</span>
            <button class="section-add-btn row-delete-btn" style="color:var(--accent-danger);">Delete</button>
          </div>
          <div class="form-group">
            <label>Button Label</label>
            <input type="text" class="input-text serif-text c-label" value="${this.escapeHtml(choice.text || "")}" placeholder="Choice description">
          </div>
          <div class="form-group">
            <label>Required Condition (optional)</label>
            <input type="text" class="input-text c-cond" value="${this.escapeHtml(choice.condition || "")}" placeholder="e.g. has_item('rusty_key')">
          </div>
          <div class="form-group">
            <label>Accept Mission (optional)</label>
            <select class="select-input c-mission">
              <option value="">None</option>
              ${this.globalVars.missions.map(m => `<option value="${this.escapeHtml(m)}" ${choice.mission === m ? "selected" : ""}>${this.escapeHtml(m)}</option>`).join("")}
            </select>
          </div>
        `;
        this.bindLive(row.querySelector(".c-label"), node, el => {
          choice.text = el.value;
          node.updateChoiceOutputs();
        });
        this.bindLive(row.querySelector(".c-cond"), node, el => { choice.condition = el.value; });
        this.bindLive(row.querySelector(".c-mission"), node, el => { choice.mission = el.value; }, "change");
        row.querySelector(".row-delete-btn").onclick = () => {
          p.choices.splice(idx, 1);
          node.updateChoiceOutputs();
          node.setDirtyCanvas(true, true);
          this.schedulePersist();
          renderChoicesRows();
        };
        rowsContainer.appendChild(row);
      });
    };

    renderChoicesRows();

    form.querySelector("#btn_add_choice_item").onclick = () => {
      p.choices.push({ text: "New Option", condition: "", mission: "" });
      node.updateChoiceOutputs();
      node.setDirtyCanvas(true, true);
      this.schedulePersist();
      renderChoicesRows();
    };
  },

  // TRAVERSAL INSPECTOR
  renderTraversalInspector(node, container) {
    const p = node.properties;
    const form = document.createElement("div");
    form.className = "inspector-scroll";
    form.style.padding = "0";

    const locOptions = this.globalVars.locations.map(loc =>
      `<option value="${this.escapeHtml(loc)}" ${p.location === loc ? "selected" : ""}>${this.escapeHtml(loc)}</option>`).join("");

    form.innerHTML = `
      <div class="form-group">
        <label>Node Title</label>
        <input type="text" class="input-text" id="insp_title" value="${this.escapeHtml(p.title || "")}">
      </div>

      <div class="form-group">
        <label>Location</label>
        <div style="display:flex; gap:6px; align-items:center;">
          <select class="select-input" id="insp_location" style="flex:1;">
            ${locOptions}
            <option value="__add__">＋ Add new location…</option>
          </select>
          <button class="btn btn-primary" id="btn_populate_from_global" style="padding:7px 12px; font-size:11px;" title="Populate background and music from the selected location's global settings">
            <i class="fas fa-sync-alt"></i> Populate from Globals
          </button>
        </div>
        <div id="insp_new_loc_row" style="display:none; gap:6px; margin-top:4px;">
          <input type="text" class="input-text" id="insp_new_loc" placeholder="New location name — press Enter">
        </div>
      </div>

      <div class="form-group">
        <label>Background Image</label>
        <div class="bg-preview" id="insp_bg_preview">No background set</div>
        <div class="file-pick-row">
          <input type="text" class="input-text" id="insp_bg" value="${this.escapeHtml(p.background || "")}" placeholder="URL, or pick a file →">
          <button class="btn file-pick-btn" id="insp_bg_pick"><i class="fas fa-folder-open"></i></button>
          <button class="btn file-pick-btn" id="insp_bg_clear" title="Clear"><i class="fas fa-times"></i></button>
        </div>
      </div>

      <div class="form-group">
        <label>Music Loop <span style="color:var(--text-dark);">(crossfades between scenes)</span></label>
        <div class="audio-row">
          <input type="text" class="input-text" id="insp_audio_loop" value="${this.escapeHtml(p.audioLoop || "")}" placeholder="URL, or pick a file →">
          <button class="btn file-pick-btn" id="insp_audio_loop_pick"><i class="fas fa-folder-open"></i></button>
          <button class="btn audio-preview-btn" id="insp_audio_loop_play" title="Preview loop"><i class="fas fa-play"></i></button>
        </div>
      </div>

      <div class="form-group">
        <label>One-Shot Sound <span style="color:var(--text-dark);">(plays once on scene enter)</span></label>
        <div class="audio-row">
          <input type="text" class="input-text" id="insp_audio_shot" value="${this.escapeHtml(p.audioOneShot || "")}" placeholder="URL, or pick a file →">
          <button class="btn file-pick-btn" id="insp_audio_shot_pick"><i class="fas fa-folder-open"></i></button>
          <button class="btn audio-preview-btn" id="insp_audio_shot_play" title="Preview one-shot"><i class="fas fa-play"></i></button>
        </div>
      </div>

      <div class="form-group">
        <label>Escape Target Score</label>
        <input type="number" class="input-text" id="insp_target" value="${p.targetAccumulation || 100}">
        <div class="field-hint">The player rolls a d20 repeatedly; reaching this total triggers the <strong>Escape / Success</strong> output. The <strong>Early Exit</strong> output lets them bail out safely between rolls — connect it to offer that path.</div>
      </div>

      <div class="form-group">
        <label style="font-weight:600; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
          Risk Events (chance per roll)
          <button class="btn btn-success" style="padding:2px 8px; font-size:11px;" id="btn_add_outcome_item">+ Add Event</button>
        </label>
        <div id="outcomes_rows_container"></div>
      </div>
    `;
    container.appendChild(form);

    const $ = id => form.querySelector("#" + id);

    this.bindLive($("insp_title"), node, el => {
      p.title = el.value;
      node.title = el.value || "Dice Maze Challenge";
    });
    this.bindLive($("insp_target"), node, el => {
      p.targetAccumulation = parseInt(el.value) || 100;
    });

    this.wireLocationField(node, form, p);
    this.wireBackgroundField(node, $("insp_bg"), $("insp_bg_preview"), $("insp_bg_pick"), $("insp_bg_clear"));
    this.wireAudioField(node, $("insp_audio_loop"), $("insp_audio_loop_pick"), $("insp_audio_loop_play"), "audioLoop", "audioLoopName", true);
    this.wireAudioField(node, $("insp_audio_shot"), $("insp_audio_shot_pick"), $("insp_audio_shot_play"), "audioOneShot", "audioOneShotName", false);

    const rowsContainer = form.querySelector("#outcomes_rows_container");

    const renderOutcomes = () => {
      rowsContainer.innerHTML = "";
      p.outcomes.forEach((out, idx) => {
        const row = document.createElement("div");
        row.className = "outcome-row";
        row.innerHTML = `
          <div class="outcome-row-header">
            <span style="font-size:12px; font-weight:600; color:var(--accent-warning);">Event #${idx + 1}</span>
            <button class="section-add-btn row-delete-btn" style="color:var(--accent-danger);">Delete</button>
          </div>
          <div class="form-group">
            <label>Event Name</label>
            <input type="text" class="input-text o-label" value="${this.escapeHtml(out.label || "")}" placeholder="e.g. Become Monster">
          </div>
          <div class="form-group">
            <label>Trigger Probability per roll (0–100%)</label>
            <input type="number" class="input-text o-prob" value="${out.probability !== undefined ? out.probability : 10}" min="0" max="100" step="0.5">
          </div>
          <div class="form-group">
            <label>Message when triggered</label>
            <input type="text" class="input-text serif-text o-desc" value="${this.escapeHtml(out.description || "")}" placeholder="e.g. The corruption takes hold!">
          </div>
        `;
        this.bindLive(row.querySelector(".o-label"), node, el => {
          out.label = el.value;
          node.updateOutputs();
        });
        this.bindLive(row.querySelector(".o-prob"), node, el => {
          out.probability = parseFloat(el.value) || 0;
        });
        this.bindLive(row.querySelector(".o-desc"), node, el => { out.description = el.value; });
        row.querySelector(".row-delete-btn").onclick = () => {
          p.outcomes.splice(idx, 1);
          node.updateOutputs();
          node.setDirtyCanvas(true, true);
          this.schedulePersist();
          renderOutcomes();
        };
        rowsContainer.appendChild(row);
      });
    };

    renderOutcomes();

    form.querySelector("#btn_add_outcome_item").onclick = () => {
      p.outcomes.push({ label: "New Event", probability: 10, description: "" });
      node.updateOutputs();
      node.setDirtyCanvas(true, true);
      this.schedulePersist();
      renderOutcomes();
    };
  },

  // LOGIC GATE INSPECTOR
  renderLogicGateInspector(node, container) {
    const p = node.properties;
    const form = document.createElement("div");
    form.className = "inspector-scroll";
    form.style.padding = "0";
    form.innerHTML = `
      <div class="form-group">
        <label>Node Title</label>
        <input type="text" class="input-text" id="insp_title" value="${this.escapeHtml(p.title || "")}">
      </div>

      <div class="form-group">
        <label>Condition Expression</label>
        <input type="text" class="input-text" id="insp_condition" value="${this.escapeHtml(p.condition || "")}" placeholder="e.g. has_knowledge('heard_rustle')">
        <div class="field-hint">
          Available checks (combine several — all must pass):<br>
          <code>has_item('item_id')</code><br>
          <code>has_knowledge('flag_name')</code><br>
          <code>mission_active('Mission Name')</code><br>
          <code>mission_done('Mission Name')</code>
        </div>
      </div>
    `;
    container.appendChild(form);

    this.bindLive(form.querySelector("#insp_title"), node, el => {
      p.title = el.value;
      node.title = el.value || "Conditional Gate";
    });
    this.bindLive(form.querySelector("#insp_condition"), node, el => { p.condition = el.value; });
  },

  // ================= DIALOGUE TEXT HELPERS =================

  // Add the colon after a leading character name if the writer forgot it.
  // Handles: "{Hero} some text" -> "{Hero}: some text"
  //          "Hero some text"   -> "Hero: some text"  (known characters only)
  normalizeDialogueText(text) {
    const chars = this.globalVars.characters || [];
    return String(text || "").split("\n").map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // {Name} without colon
      let m = trimmed.match(/^\{([^}]+)\}(?!\s*:)\s*(.*)$/);
      if (m) return `{${m[1]}}: ${m[2]}`.trim();

      // Already "something:" — leave alone
      if (/^[^:{}]{1,32}:/.test(trimmed)) return line;

      // Starts with a known character name but no colon
      for (const c of chars) {
        const lower = trimmed.toLowerCase();
        const cl = c.toLowerCase();
        if (lower === cl) return c + ":";
        if (lower.startsWith(cl + " ")) {
          return c + ": " + trimmed.slice(c.length).trim();
        }
      }
      return line;
    }).join("\n");
  },

  setupAutocomplete(textareaId, menuId) {
    const textarea = document.getElementById(textareaId);
    const menu = document.getElementById(menuId);
    if (!textarea || !menu) return;

    let showMenu = false;
    let queryStart = -1;

    textarea.addEventListener("input", () => {
      const val = textarea.value;
      const caretPos = textarea.selectionStart;
      const textBeforeCaret = val.substring(0, caretPos);

      const openBraceIdx = textBeforeCaret.lastIndexOf("{");
      const closeBraceIdx = textBeforeCaret.lastIndexOf("}");

      if (openBraceIdx > closeBraceIdx && openBraceIdx !== -1) {
        showMenu = true;
        queryStart = openBraceIdx;
        const query = textBeforeCaret.substring(openBraceIdx + 1).toLowerCase();
        this.showSuggestions(query, menu, textarea, queryStart);
      } else {
        showMenu = false;
        menu.style.display = "none";
      }
    });

    textarea.addEventListener("keydown", (e) => {
      if (!showMenu) return;
      const items = menu.querySelectorAll(".autocomplete-item");
      let activeIdx = -1;
      items.forEach((item, index) => {
        if (item.classList.contains("active")) activeIdx = index;
      });

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (items.length > 0) {
          const nextIdx = (activeIdx + 1) % items.length;
          if (activeIdx !== -1) items[activeIdx].classList.remove("active");
          items[nextIdx].classList.add("active");
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (items.length > 0) {
          const prevIdx = activeIdx <= 0 ? items.length - 1 : activeIdx - 1;
          if (activeIdx !== -1) items[activeIdx].classList.remove("active");
          items[prevIdx].classList.add("active");
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        const activeItem = menu.querySelector(".autocomplete-item.active");
        if (activeItem) activeItem.click();
        else if (items.length > 0) items[0].click();
      } else if (e.key === "Escape") {
        showMenu = false;
        menu.style.display = "none";
      }
    });
  },

  showSuggestions(query, menu, textarea, queryStart) {
    const suggestions = [];
    this.globalVars.characters.forEach(c => suggestions.push({ name: c, type: 'char', color: '#fbbf24' }));
    this.globalVars.locations.forEach(l => suggestions.push({ name: l, type: 'loc', color: '#34d399' }));

    const filtered = suggestions.filter(s => s.name.toLowerCase().includes(query));
    if (filtered.length === 0) {
      menu.style.display = "none";
      return;
    }

    menu.innerHTML = "";
    filtered.forEach((item, index) => {
      const el = document.createElement("div");
      el.className = "autocomplete-item" + (index === 0 ? " active" : "");
      el.innerHTML = `
        <span>{${this.escapeHtml(item.name)}}</span>
        <span class="type-badge" style="background:${item.color}22; color:${item.color};">${item.type}</span>
      `;
      el.onclick = () => {
        const val = textarea.value;
        const caretPos = textarea.selectionStart;
        const before = val.substring(0, queryStart);
        const after = val.substring(caretPos);
        textarea.value = before + `{${item.name}}` + after;
        textarea.focus();
        textarea.setSelectionRange(queryStart + item.name.length + 2, queryStart + item.name.length + 2);
        textarea.dispatchEvent(new Event("input"));
        menu.style.display = "none";
      };
      menu.appendChild(el);
    });

    menu.style.display = "block";
  },

  setupDialogueHighlight(textareaId, helperId) {
    const textarea = document.getElementById(textareaId);
    const helper = document.getElementById(helperId);
    if (!textarea || !helper) return;

    const updateHighlight = () => {
      const lines = String(textarea.value || "").split("\n");
      const html = lines.map(line => {
        let out = this.escapeHtml(line);
        // Speaker prefix: "Name:" or "{Name}:" or "{Name}"
        const m = line.match(/^\s*\{?([^:{}]{1,32}?)\}?\s*:\s*(.*)$/);
        if (m) {
          out = `<span class="tag-highlight char">${this.escapeHtml(m[1].trim())}</span> ${this.escapeHtml(m[2])}`;
        }
        // Inline {tokens}
        out = out.replace(/\{([^}]+)\}/g, (_, name) => {
          const cls = this.globalVars.locations.includes(name) ? "loc" : "char";
          return `<span class="tag-highlight ${cls}">${this.escapeHtml(name)}</span>`;
        });
        return out;
      }).join("\n");
      helper.innerHTML = html || '<span style="color:var(--text-dark);">Preview appears here…</span>';
    };

    textarea.addEventListener("input", updateHighlight);
    updateHighlight();
  },

  // Offer to add unknown speaker names found in dialogue to the character list
  setupSpeakerQuickAdd(textarea, bubble) {
    const scan = () => {
      const known = this.globalVars.characters.map(c => c.toLowerCase());
      const unknowns = [];
      String(textarea.value || "").split("\n").forEach(line => {
        const m = line.trim().match(/^\{?([A-Za-z][A-Za-z0-9 .'\-]{0,28}?)\}?\s*:\s+/);
        if (m) {
          const name = m[1].trim();
          if (!known.includes(name.toLowerCase()) && !unknowns.includes(name)) unknowns.push(name);
        }
      });

      if (unknowns.length === 0) {
        bubble.style.display = "none";
        return;
      }
      const next = unknowns[0];
      bubble.style.display = "flex";
      bubble.innerHTML = `
        <span>"<strong>${this.escapeHtml(next)}</strong>" isn't a known character yet.</span>
        <button class="btn btn-success" style="padding:2px 8px; font-size:11px;">Add to Characters</button>
      `;
      bubble.querySelector("button").onclick = () => {
        this.addVariable("characters", next);
        scan();
        // refresh highlight colors
        textarea.dispatchEvent(new Event("input"));
      };
    };
    textarea.addEventListener("input", scan);
    scan();
  },

  updateInspectorAutocompletes() {
    // Re-run highlight on the open dialogue editor so new names get colored
    const ta = document.getElementById("insp_text");
    if (ta) ta.dispatchEvent(new Event("input"));
  },

  // ================= STORY COMPILER & PLAYBACK =================

  // Convert the live LiteGraph into the plain JSON the StoryPlayer runtime
  // consumes (also what Publish embeds into the standalone HTML).
  compileStory() {
    const g = this.graph.serialize();
    const typeMap = {
      "vnovel/passthrough": "dialogue",
      "vnovel/choice": "choice",
      "vnovel/traversal": "traversal",
      "vnovel/logic_gate": "logic"
    };

    const nodes = {};
    const hasInput = new Set();

    (g.nodes || []).forEach(n => {
      nodes[n.id] = {
        type: typeMap[n.type] || "dialogue",
        p: n.properties || {},
        out: []
      };
    });

    (g.links || []).forEach(l => {
      // Serialized link: [id, origin_id, origin_slot, target_id, target_slot, type]
      if (!Array.isArray(l)) return;
      const src = nodes[l[1]];
      if (src && (src.out[l[2]] === undefined || src.out[l[2]] === null)) {
        src.out[l[2]] = l[3];
      }
      hasInput.add(l[3]);
    });

    // Entry: bookmarked chapter > dialogue node with no incoming link > first node
    let entry = null;
    const list = g.nodes || [];
    const chapter = list.find(n => n.properties && n.properties.isChapterStart);
    if (chapter) entry = chapter.id;
    if (entry === null) {
      const orphan = list.find(n => n.type === "vnovel/passthrough" && !hasInput.has(n.id));
      if (orphan) entry = orphan.id;
    }
    if (entry === null && list.length) entry = list[0].id;

    return {
      title: this.projectTitle,
      entry,
      vars: this.globalVars,
      varMeta: this.varMeta,
      nodes
    };
  },

  getSelectedStoryNode() {
    const sel = Object.values(this.canvas.selected_nodes || {});
    if (sel.length === 1 && sel[0].type && sel[0].type.startsWith("vnovel/")) return sel[0];
    return null;
  },

  startPlayback(customStartNode = null, customStartState = null) {
    const story = this.compileStory();
    if (!Object.keys(story.nodes).length) {
      this.toast("Add some nodes first — the story is empty!", "warning");
      return;
    }
    const startNode = customStartNode || this.getSelectedStoryNode();
    const entry = startNode ? startNode.id : story.entry;

    this.stopAudioPreview();
    this.closeInspector();
    this.gamePlaying = true;

    document.getElementById("playback_overlay").classList.add("active");
    const root = document.getElementById("playback_root");
    this.player = new StoryPlayer(root, story, { onExit: () => this.stopPlayback() });
    this.player.start(entry, customStartState);
  },

  stopPlayback() {
    if (this.player) {
      this.player.destroy();
      this.player = null;
    }
    this.gamePlaying = false;
    document.getElementById("playback_overlay").classList.remove("active");
    this.renderBookmarks();
  },

  // ================= PUBLISH (standalone playable HTML) =================

  publishStory() {
    const story = this.compileStory();
    if (!Object.keys(story.nodes).length) {
      this.toast("Nothing to publish yet — the story is empty.", "warning");
      return;
    }
    const html = this.buildStandaloneHTML(story);
    const slug = (this.projectTitle || "story").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "story";
    this.downloadFile(`${slug}.html`, html, "text/html");
    if (JSON.stringify(story).includes('"assets/')) {
      this.toast("This story references files by path — ship the assets folder alongside the downloaded HTML.", "warning");
    }
    this.toast("Standalone story downloaded! Anyone can open the HTML file in a browser — no install, no server.", "success");
  },

  buildStandaloneHTML(story) {
    // Guard against user text containing a closing script tag
    const json = JSON.stringify(story).replace(/<\//g, "<\\/");
    const playerSource = StoryPlayer.toString();
    const scriptClose = "</" + "script>";
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${this.escapeHtml(story.title || "A Story")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=EB+Garamond:ital,wght@0,400;0,600;0,700;1,400&display=swap" rel="stylesheet">
<style>
  html, body { margin:0; height:100%; background:#05060a; overflow:hidden; }
  #story_root { position:fixed; inset:0; }
</style>
</head>
<body>
<div id="story_root"></div>
<script>
var STORY = ${json};
${playerSource}
new StoryPlayer(document.getElementById("story_root"), STORY, { standalone: true }).start(STORY.entry);
${scriptClose}
</body>
</html>`;
  },

  downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },

  // ================= SAVE / LOAD / IMPORT / EXPORT =================

  saveToLocalStorage() {
    if (!this.graph) return;
    try {
      localStorage.setItem("vnovel_active_save_v2", JSON.stringify(this.currentState()));
    } catch (err) {
      if (!this._quotaWarned) {
        this._quotaWarned = true;
        this.toast("Autosave failed — project too large for browser storage (embedded files?). Use Export to keep a backup!", "danger");
      }
    }
  },

  loadFromLocalStorage() {
    const saved = localStorage.getItem("vnovel_active_save_v2");
    if (saved) {
      try {
        const state = JSON.parse(saved);
        if (state.graphSchema) this.graph.configure(state.graphSchema);
        if (state.globalVars) this.globalVars = state.globalVars;
        if (state.varMeta) this.varMeta = state.varMeta;
        if (state.projectTitle) this.setProjectTitle(state.projectTitle);
        this.bookmarks = state.bookmarks || [];
        this.ensureVarShape();
        this.renderGlobalTags();
        this.renderBookmarks();
        this.canvas.draw(true, true);
        return true;
      } catch (err) {
        console.error("Local load failed. Loading default demo instead.", err);
      }
    }
    return false;
  },

  newGraph() {
    this.openModal("new_modal_overlay");
  },

  _resetProject() {
    this.checkpoint(); // make sure current work is undoable
    this.graph.clear();
    this.closeInspector();
    this.setProjectTitle("Untitled Story");
    this.bookmarks = [];
  },

  newEmptyGraph() {
    this._resetProject();
    this.globalVars = { characters: [], locations: [], collectibles: [], knowledge: [], missions: [] };
    this.varMeta = {};
    this.renderGlobalTags();
    this.renderBookmarks();
    this.canvas.draw(true, true);
    this.saveToLocalStorage();
    this.checkpoint();
    this.closeModal("new_modal_overlay");
    this.toast("Empty graph created. Double-click the canvas to add your first Dialogue node.", "success");
  },

  newTemplateGraph() {
    this._resetProject();
    this.buildTemplateProject();
    this.saveToLocalStorage();
    this.checkpoint();
    this.closeModal("new_modal_overlay");
    this.toast("Starter template loaded — every node type is on the canvas. Play it, then make it yours!", "success");
  },

  exportProject() {
    this.openModal("export_modal_overlay");
  },

  doExport() {
    const formatSelect = document.getElementById("export_format_select");
    const format = formatSelect ? formatSelect.value : "json";
    const state = this.currentState();
    const slug = (this.projectTitle || "vnovel-project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "vnovel-project";

    if (format === "markdown") {
      const md = this.exportToMarkdown(state);
      this.downloadFile(`${slug}.md`, md, "text/markdown");
      this.closeModal("export_modal_overlay");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(md).then(
          () => this.toast("Project exported: file downloaded + Markdown copied to clipboard", "success"),
          () => this.toast("Project file downloaded", "success")
        );
      } else {
        this.toast("Project file downloaded", "success");
      }
    } else {
      // JSON format
      const str = JSON.stringify(state, null, 2);
      this.downloadFile(`${slug}.json`, str, "application/json");
      this.closeModal("export_modal_overlay");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(str).then(
          () => this.toast("Project exported: file downloaded + JSON copied to clipboard", "success"),
          () => this.toast("Project file downloaded", "success")
        );
      } else {
        this.toast("Project file downloaded", "success");
      }
    }
  },

  exportToMarkdown(state) {
    let md = "";
    
    // Title
    md += `# Project: ${state.projectTitle || "Untitled Story"}\n\n`;
    
    // Globals
    md += "---\nGlobals:\n";
    if (state.globalVars) {
      const cats = {
        characters: "Characters",
        locations: "Locations",
        collectibles: "Collectibles",
        knowledge: "Knowledge",
        missions: "Missions"
      };
      for (const key in cats) {
        const list = state.globalVars[key] || [];
        if (list.length) {
          md += `- ${cats[key]}: ${list.join(", ")}\n`;
        }
      }
    }
    md += "---\n\n";
    
    // Build link lookup map
    const linkToTarget = {};
    const links = (state.graphSchema && state.graphSchema.links) || [];
    links.forEach(l => {
      // l: [link_id, origin_id, origin_slot, target_id, target_slot, type]
      linkToTarget[l[0]] = l[3];
    });

    const getTargetId = (node, slotIdx) => {
      const output = node.outputs && node.outputs[slotIdx];
      const outLinks = output && output.links;
      return outLinks && outLinks[0] ? linkToTarget[outLinks[0]] : null;
    };

    // Nodes
    const typeMap = {
      "vnovel/passthrough": "dialogue",
      "vnovel/choice": "choice",
      "vnovel/traversal": "traversal",
      "vnovel/logic_gate": "logic"
    };

    const nodes = (state.graphSchema && state.graphSchema.nodes) || [];
    nodes.forEach(node => {
      const rawType = node.type;
      const type = typeMap[rawType] || "dialogue";
      const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
      
      md += `## Node ${node.id} (${typeLabel})\n`;
      const p = node.properties || {};
      if (p.title) md += `Title: ${p.title}\n`;
      if (p.location) md += `Location: ${p.location}\n`;
      if (p.backgroundName) md += `Background: ${p.backgroundName}\n`;
      if (p.audioLoopName) md += `AudioLoop: ${p.audioLoopName}\n`;
      if (p.audioOneShotName) md += `AudioOneShot: ${p.audioOneShotName}\n`;
      if (p.rewardItems) md += `RewardItems: ${p.rewardItems}\n`;
      if (p.rewardKnowledge) md += `RewardKnowledge: ${p.rewardKnowledge}\n`;
      if (p.startMission) md += `StartMission: ${p.startMission}\n`;
      if (p.completeMission) md += `CompleteMission: ${p.completeMission}\n`;
      if (p.isChapterStart) md += `IsChapterStart: true\n`;
      
      if (type === "dialogue") {
        if (p.text) {
          md += "Dialogue:\n" + p.text.split("\n").map(line => line).join("\n") + "\n";
        }
        const nextId = getTargetId(node, 0);
        if (nextId != null) {
          md += `Next: ${nextId}\n`;
        }
      } else if (type === "choice") {
        md += "Choices:\n";
        const choices = p.choices || [];
        choices.forEach((c, idx) => {
          const targetId = getTargetId(node, idx);
          const targetStr = targetId != null ? ` -> Node ${targetId}` : "";
          const condStr = c.condition ? ` (requires: ${c.condition})` : "";
          const missionStr = c.mission ? ` (Starts: ${c.mission})` : "";
          md += `- [${c.text}]${targetStr}${condStr}${missionStr}\n`;
        });
      } else if (type === "traversal") {
        if (p.targetAccumulation) md += `Target: ${p.targetAccumulation}\n`;
        md += "Outcomes:\n";
        const outcomes = p.outcomes || [];
        outcomes.forEach((o, idx) => {
          const targetId = getTargetId(node, idx + 1);
          const targetStr = targetId != null ? ` -> Node ${targetId}` : "";
          md += `- [${o.label}] (${o.probability}%): ${o.description || ""}${targetStr}\n`;
        });
        const escapeId = getTargetId(node, 0);
        if (escapeId != null) md += `Escape: Node ${escapeId}\n`;
        const earlyExitId = getTargetId(node, outcomes.length + 1);
        if (earlyExitId != null) md += `Early Exit: Node ${earlyExitId}\n`;
      } else if (type === "logic") {
        if (p.condition) md += `Check: ${p.condition}\n`;
        const trueId = getTargetId(node, 0);
        if (trueId != null) md += `True: Node ${trueId}\n`;
        const falseId = getTargetId(node, 1);
        if (falseId != null) md += `False: Node ${falseId}\n`;
      }
      
      md += "\n";
    });
    
    return md;
  },

  parseMarkdown(md) {
    const lines = md.split(/\r?\n/);
    const vars = {
      characters: [],
      locations: [],
      collectibles: [],
      knowledge: [],
      missions: []
    };
    const varMeta = {};
    const nodes = {};
    let projectTitle = "Untitled Story";
    
    let currentMode = "GLOBAL";
    let currentNodeId = null;
    let currentNode = null;
    let textLines = [];
    let state = "HEADER";

    const flushDialogue = () => {
      if (currentNode && textLines.length > 0) {
        currentNode.p.text = textLines.join("\n").trim();
        textLines = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      const nodeMatch = trimmed.match(/^##\s*(?:Node\s*)?(\d+)(?:\s*\(([^)]+)\))?/i);
      if (nodeMatch) {
        flushDialogue();
        currentMode = "NODE";
        state = "PROPERTIES";
        currentNodeId = parseInt(nodeMatch[1], 10);
        let nodeType = (nodeMatch[2] || "dialogue").toLowerCase().trim();
        
        if (nodeType === "passthrough" || nodeType === "scene") nodeType = "dialogue";
        if (nodeType === "path" || nodeType === "branch") nodeType = "choice";
        if (nodeType === "maze" || nodeType === "minigame") nodeType = "traversal";
        if (nodeType === "logic_gate" || nodeType === "gate" || nodeType === "conditional") nodeType = "logic";

        currentNode = {
          type: nodeType,
          p: {
            title: `Node ${currentNodeId}`,
            location: "",
            text: ""
          },
          out: []
        };
        
        if (nodeType === "choice") {
          currentNode.p.choices = [];
        } else if (nodeType === "traversal") {
          currentNode.p.targetAccumulation = 100;
          currentNode.p.outcomes = [];
        } else if (nodeType === "logic") {
          currentNode.p.condition = "";
        }
        
        nodes[currentNodeId] = currentNode;
        continue;
      }

      if (state === "HEADER") {
        const titleMatch = trimmed.match(/^#\s*Project\s*:\s*(.*)/i) || trimmed.match(/^#\s*Title\s*:\s*(.*)/i) || trimmed.match(/^#\s*(?!\s*#)(.*)/);
        if (titleMatch) {
          projectTitle = titleMatch[1].trim();
          continue;
        }
      }

      if (currentMode === "GLOBAL") {
        const varMatch = trimmed.match(/^-\s*([A-Za-z]+)\s*:\s*(.*)/);
        if (varMatch) {
          const rawCat = varMatch[1].toLowerCase().trim();
          const items = varMatch[2].split(",").map(x => x.trim()).filter(Boolean);
          
          let cat = null;
          if (rawCat.startsWith("char")) cat = "characters";
          if (rawCat.startsWith("loc")) cat = "locations";
          if (rawCat.startsWith("collect") || rawCat.startsWith("item") || rawCat.startsWith("prop")) cat = "collectibles";
          if (rawCat.startsWith("know") || rawCat.startsWith("flag") || rawCat.startsWith("diary")) cat = "knowledge";
          if (rawCat.startsWith("miss")) cat = "missions";
          
          if (cat) {
            vars[cat] = Array.from(new Set([...(vars[cat] || []), ...items]));
          }
        }
        continue;
      }

      if (currentMode === "NODE" && currentNode) {
        if (trimmed.toLowerCase().startsWith("dialogue:") || trimmed.toLowerCase().startsWith("text:")) {
          flushDialogue();
          state = "DIALOGUE";
          continue;
        }
        if (trimmed.toLowerCase().startsWith("choices:") || trimmed.toLowerCase().startsWith("options:")) {
          flushDialogue();
          state = "CHOICES";
          continue;
        }
        if (trimmed.toLowerCase().startsWith("outcomes:") || trimmed.toLowerCase().startsWith("risks:")) {
          flushDialogue();
          state = "OUTCOMES";
          continue;
        }

        if (state === "DIALOGUE") {
          const propCheck = trimmed.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)/);
          if (propCheck && !propCheck[1].match(/^(mr\.|ms\.|esss|trout|narrator|char|joe|bill|frank)/i)) {
            state = "PROPERTIES";
          } else {
            textLines.push(line);
            continue;
          }
        }

        const propMatch = trimmed.match(/^([A-Za-z0-9_ ]+)\s*:\s*(.*)/i);
        if (propMatch) {
          const key = propMatch[1].toLowerCase().replace(/\s+/g, "").trim();
          const val = propMatch[2].trim();
          
          if (key === "title") currentNode.p.title = val;
          else if (key === "location" || key === "loc") currentNode.p.location = val;
          else if (key === "background" || key === "bg") {
            currentNode.p.backgroundName = val.replace(/^assets\//, "");
            currentNode.p.background = val.startsWith("assets/") ? val : "assets/" + val;
          }
          else if (key === "audioloop") {
            currentNode.p.audioLoopName = val;
            currentNode.p.audioLoop = val;
          }
          else if (key === "audiooneshot" || key === "audioshot") {
            currentNode.p.audioOneShotName = val;
            currentNode.p.audioOneShot = val;
          }
          else if (key === "rewarditems" || key === "rewarditem" || key === "item") currentNode.p.rewardItems = val;
          else if (key === "rewardknowledge" || key === "rewardknow") currentNode.p.rewardKnowledge = val;
          else if (key === "startmission") currentNode.p.startMission = val;
          else if (key === "completemission") currentNode.p.completeMission = val;
          else if (key === "ischapterstart" || key === "bookmark") currentNode.p.isChapterStart = (val.toLowerCase() === "true");
          else if (key === "next") {
            const nextId = parseInt(val.replace(/[^\d]/g, ""), 10);
            if (!isNaN(nextId)) currentNode.out[0] = nextId;
          }
          else if (key === "escape" || key === "success") {
            const escId = parseInt(val.replace(/[^\d]/g, ""), 10);
            if (!isNaN(escId)) currentNode.out[0] = escId;
          }
          else if (key === "earlyexit" || key === "exit") {
            const exitId = parseInt(val.replace(/[^\d]/g, ""), 10);
            currentNode._earlyExitTarget = exitId;
          }
          else if (key === "true") {
            const trueId = parseInt(val.replace(/[^\d]/g, ""), 10);
            if (!isNaN(trueId)) currentNode.out[0] = trueId;
          }
          else if (key === "false") {
            const falseId = parseInt(val.replace(/[^\d]/g, ""), 10);
            if (!isNaN(falseId)) currentNode.out[1] = falseId;
          }
          else if (key === "check" || key === "condition" || key === "cond") {
            currentNode.p.condition = val;
          }
          else if (key === "target" || key === "targetscore") {
            currentNode.p.targetAccumulation = parseInt(val, 10) || 100;
          }
          continue;
        }

        if (state === "CHOICES" && trimmed.startsWith("-")) {
          const choiceMatch = trimmed.match(/^-\s*\[([^\]]+)\](?:\s*->\s*(?:Node\s*)?(\d+))?(.*)/i);
          if (choiceMatch) {
            const cText = choiceMatch[1].trim();
            const targetId = choiceMatch[2] ? parseInt(choiceMatch[2], 10) : null;
            const extra = choiceMatch[3] || "";
            
            let condition = "";
            let reqMatch = extra.match(/requires:\s*(.*?)(?=\)\s*(?:\(|$))/i);
            if (reqMatch) {
              condition = reqMatch[1].trim();
            } else {
              reqMatch = extra.match(/requires:\s*([^ ]+)/i);
              if (reqMatch) condition = reqMatch[1].trim();
            }
            
            let mission = "";
            const startMatch = extra.match(/\(\s*Starts:\s*([^)]+)\)/i) || extra.match(/\(\s*mission:\s*([^)]+)\)/i) || extra.match(/Starts:\s*([^ ]+)/i) || extra.match(/mission:\s*([^ ]+)/i);
            if (startMatch) {
              mission = startMatch[1].trim();
            }

            const choiceObj = {
              text: cText,
              condition: condition,
              mission: mission
            };
            currentNode.p.choices.push(choiceObj);
            
            if (targetId !== null) {
              const idx = currentNode.p.choices.length - 1;
              currentNode.out[idx] = targetId;
            }
          }
          continue;
        }

        if (state === "OUTCOMES" && trimmed.startsWith("-")) {
          const outcomeMatch = trimmed.match(/^-\s*\[([^\]]+)\](?:\s*\((\d+)\s*%\))?\s*:\s*([^->]*)(?:\s*->\s*(?:Node\s*)?(\d+))?/i);
          if (outcomeMatch) {
            const label = outcomeMatch[1].trim();
            const prob = outcomeMatch[2] ? parseInt(outcomeMatch[2], 10) : 10;
            const desc = outcomeMatch[3].trim();
            const targetId = outcomeMatch[4] ? parseInt(outcomeMatch[4], 10) : null;
            
            currentNode.p.outcomes.push({
              label,
              probability: prob,
              description: desc
            });
            
            if (targetId !== null) {
              const idx = currentNode.p.outcomes.length;
              currentNode.out[idx] = targetId;
            }
          }
          continue;
        }
      }
    }
    
    flushDialogue();

    // First, resolve traversal early exit targets
    for (const nid in nodes) {
      const node = nodes[nid];
      if (node.type === "traversal" && node._earlyExitTarget !== undefined) {
        const exitSlot = (node.p.outcomes || []).length + 1;
        node.out[exitSlot] = node._earlyExitTarget;
      }
    }

    // Scan for unresolved forward references and create placeholders
    const placeholderIds = new Set();
    for (const nid in nodes) {
      const node = nodes[nid];
      node.out.forEach(destId => {
        if (destId != null && !nodes[destId]) {
          placeholderIds.add(destId);
        }
      });
    }

    placeholderIds.forEach(pid => {
      nodes[pid] = {
        type: "dialogue",
        p: {
          title: `Placeholder ${pid}`,
          location: "",
          text: `Narrator: (Placeholder scene for Node ${pid}. Double click to edit.)`
        },
        out: []
      };
    });

    const finalNodes = {};
    const entryId = Object.keys(nodes).length > 0 ? parseInt(Object.keys(nodes)[0], 10) : null;

    for (const nid in nodes) {
      const node = nodes[nid];
      const type = node.type;
      
      const maxSlots = type === "dialogue" ? 1 : 
                       type === "choice" ? node.p.choices.length : 
                       type === "traversal" ? (node.p.outcomes || []).length + 2 : 
                       type === "logic" ? 2 : 1;
      
      const outList = [];
      for (let s = 0; s < maxSlots; s++) {
        outList[s] = node.out[s] !== undefined ? node.out[s] : null;
      }

      finalNodes[nid] = {
        type,
        p: node.p,
        out: outList
      };
    }

    const graphSchema = {
      last_node_id: Math.max(0, ...Object.keys(nodes).map(x => parseInt(x, 10))),
      last_link_id: 0,
      nodes: [],
      links: [],
      groups: [],
      config: {}
    };

    let linkIdCounter = 1;
    const nodeInstanceList = [];
    const linkInstanceList = [];

    let gridX = 100;
    let gridY = 150;

    for (const nidStr in finalNodes) {
      const nid = parseInt(nidStr, 10);
      const fn = finalNodes[nid];
      
      const typeMap = {
        "dialogue": "vnovel/passthrough",
        "choice": "vnovel/choice",
        "traversal": "vnovel/traversal",
        "logic": "vnovel/logic_gate"
      };

      const lgNode = {
        id: nid,
        type: typeMap[fn.type] || "vnovel/passthrough",
        pos: [gridX, gridY],
        size: fn.type === "logic" ? [220, 80] : [240, 110],
        flags: {},
        order: nid,
        mode: 0,
        inputs: [{"name": "In", "type": -1, "link": null}],
        outputs: [],
        title: fn.p.title || `Node ${nid}`,
        properties: fn.p
      };

      if (fn.type === "dialogue") {
        lgNode.outputs.push({"name": "Out", "type": -1, "links": []});
      } else if (fn.type === "choice") {
        const choices = fn.p.choices || [];
        choices.forEach((c) => {
          lgNode.outputs.push({"name": c.text, "type": -1, "links": [], "label": c.text});
        });
      } else if (fn.type === "traversal") {
        lgNode.outputs.push({"name": "🎉 Escape / Success", "type": -1, "links": [], "label": "🎉 Escape / Success"});
        const outcomes = fn.p.outcomes || [];
        outcomes.forEach((o) => {
          lgNode.outputs.push({"name": o.label, "type": -1, "links": [], "label": o.label});
        });
        lgNode.outputs.push({"name": "🚪 Early Exit", "type": -1, "links": [], "label": "🚪 Early Exit"});
      } else if (fn.type === "logic") {
        lgNode.outputs.push({"name": "True Path", "type": -1, "links": []});
        lgNode.outputs.push({"name": "False Path", "type": -1, "links": []});
      }

      nodeInstanceList.push(lgNode);

      gridX += 300;
      if (gridX > 1400) {
        gridX = 100;
        gridY += 240;
      }
    }

    const nodeInstanceDict = {};
    nodeInstanceList.forEach(n => { nodeInstanceDict[n.id] = n; });

    for (const nidStr in finalNodes) {
      const nid = parseInt(nidStr, 10);
      const fn = finalNodes[nid];
      const srcNode = nodeInstanceDict[nid];
      
      fn.out.forEach((destId, slotIdx) => {
        if (destId != null && nodeInstanceDict[destId]) {
          const destNode = nodeInstanceDict[destId];
          const linkId = linkIdCounter++;
          
          if (srcNode.outputs[slotIdx]) {
            if (!srcNode.outputs[slotIdx].links) srcNode.outputs[slotIdx].links = [];
            srcNode.outputs[slotIdx].links.push(linkId);
          }
          destNode.inputs[0].link = linkId;

          linkInstanceList.push([linkId, nid, slotIdx, destId, 0, -1]);
        }
      });
    }

    graphSchema.nodes = nodeInstanceList;
    graphSchema.links = linkInstanceList;
    graphSchema.last_link_id = linkIdCounter - 1;

    return {
      title: projectTitle,
      entry: entryId,
      vars,
      varMeta,
      graphSchema
    };
  },

  applyImportedState(state, mode = "replace") {
    if (mode === "append") {
      // 1. Merge globalVars (avoiding duplicates)
      if (state.globalVars) {
        if (!this.globalVars) this.globalVars = {};
        for (const category in state.globalVars) {
          const existingArray = this.globalVars[category] || [];
          const importedArray = state.globalVars[category] || [];
          this.globalVars[category] = Array.from(new Set([...existingArray, ...importedArray]));
        }
      }

      // 2. Merge varMeta
      if (state.varMeta) {
        if (!this.varMeta) this.varMeta = {};
        for (const category in state.varMeta) {
          if (!this.varMeta[category]) this.varMeta[category] = {};
          Object.assign(this.varMeta[category], state.varMeta[category]);
        }
      }

      // 3. Merge graphSchema
      if (state.graphSchema) {
        const existingSchema = this.graph.serialize();
        const nOffset = existingSchema.last_node_id || 0;
        const lOffset = existingSchema.last_link_id || 0;

        const newNodes = (state.graphSchema.nodes || []).map(node => {
          const cloned = JSON.parse(JSON.stringify(node));
          cloned.id = cloned.id + nOffset;
          if (cloned.inputs) {
            cloned.inputs.forEach(input => {
              if (input.link != null) input.link += lOffset;
            });
          }
          if (cloned.outputs) {
            cloned.outputs.forEach(output => {
              if (output.links) {
                output.links = output.links.map(lid => lid + lOffset);
              }
            });
          }
          if (cloned.pos) {
            cloned.pos[0] += 50;
            cloned.pos[1] += 50;
          }
          return cloned;
        });

        const newLinks = (state.graphSchema.links || []).map(link => {
          const cloned = [...link];
          cloned[0] += lOffset;
          cloned[1] += nOffset;
          cloned[3] += nOffset;
          return cloned;
        });

        const mergedSchema = {
          last_node_id: Math.max(nOffset, (state.graphSchema.last_node_id || 0) + nOffset),
          last_link_id: Math.max(lOffset, (state.graphSchema.last_link_id || 0) + lOffset),
          nodes: (existingSchema.nodes || []).concat(newNodes),
          links: (existingSchema.links || []).concat(newLinks),
          groups: (existingSchema.groups || []).concat(state.graphSchema.groups || []),
          config: existingSchema.config || {}
        };

        this.graph.configure(mergedSchema);

        // Select the newly appended nodes
        this.canvas.selected_nodes = {};
        newNodes.forEach(n => {
          const nodeInstance = this.graph.getNodeById(n.id);
          if (nodeInstance) {
            this.canvas.selected_nodes[nodeInstance.id] = nodeInstance;
          }
        });
        // 4. Merge bookmarks
        if (state.bookmarks) {
          if (!this.bookmarks) this.bookmarks = [];
          const nOffset = existingSchema.last_node_id || 0;
          state.bookmarks.forEach(bm => {
            const cloned = JSON.parse(JSON.stringify(bm));
            cloned.id = "bm_append_" + cloned.id + "_" + Date.now();
            cloned.nodeId = cloned.nodeId + nOffset;
            this.bookmarks.push(cloned);
          });
        }
      }
    } else {
      // replace mode (original behavior)
      if (state.graphSchema) this.graph.configure(state.graphSchema);
      if (state.globalVars) this.globalVars = state.globalVars;
      if (state.varMeta) this.varMeta = state.varMeta;
      if (state.projectTitle) this.setProjectTitle(state.projectTitle);
      this.bookmarks = state.bookmarks || [];
    }

    this.ensureVarShape();
    this.renderGlobalTags();
    this.renderBookmarks();
    this.canvas.draw(true, true);
    this.saveToLocalStorage();
    this.checkpoint();
  },

  doImport() {
    const fileInput = document.getElementById("import_file_input");
    const textInput = document.getElementById("import_text_input");
    const modeSelect = document.getElementById("import_mode_select");
    const mode = modeSelect ? modeSelect.value : "replace";

    const finish = (raw) => {
      try {
        let state;
        const isJson = raw.trim().startsWith("{") || raw.trim().startsWith("[");
        if (isJson) {
          state = JSON.parse(raw);
        } else {
          state = this.parseMarkdown(raw);
        }
        this.applyImportedState(state, mode);
        this.closeModal("import_modal_overlay");
        textInput.value = "";
        fileInput.value = "";
        this.toast(mode === "append" ? "Project appended!" : "Project imported!", "success");
      } catch (err) {
        console.error(err);
        this.toast("Import failed: " + err.message, "danger");
      }
    };

    const file = fileInput.files && fileInput.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => finish(reader.result);
      reader.readAsText(file);
    } else if (textInput.value.trim()) {
      finish(textInput.value);
    } else {
      this.toast("Choose a file or paste JSON/Markdown first.", "warning");
    }
  },

  // ---- Named versions (localStorage) ----

  getVersions() {
    try {
      return JSON.parse(localStorage.getItem("vnovel_versions") || "[]");
    } catch (e) { return []; }
  },

  setVersions(list) {
    try {
      localStorage.setItem("vnovel_versions", JSON.stringify(list));
      return true;
    } catch (err) {
      this.toast("Couldn't save version — browser storage is full. Export instead, or delete old versions.", "danger");
      return false;
    }
  },

  saveVersion() {
    const input = document.getElementById("version_name_input");
    const name = input.value.trim() || `Version ${new Date().toLocaleString()}`;
    const list = this.getVersions();
    list.unshift({ name, date: new Date().toISOString(), state: this.currentState() });
    if (list.length > 25) list.length = 25;
    if (this.setVersions(list)) {
      input.value = "";
      this.renderVersionsList();
      this.toast(`Version "${name}" saved`, "success");
    }
  },

  renderVersionsList() {
    const container = document.getElementById("versions_list");
    const list = this.getVersions();
    if (!list.length) {
      container.innerHTML = `<div style="font-size:12px; color:var(--text-dark); font-style:italic;">No saved versions yet.</div>`;
      return;
    }
    container.innerHTML = "";
    list.forEach((v, i) => {
      const row = document.createElement("div");
      row.className = "version-row";
      const d = new Date(v.date);
      row.innerHTML = `
        <div>
          <div class="v-name">${this.escapeHtml(v.name)}</div>
          <div class="v-date">${d.toLocaleString()}</div>
        </div>
        <div class="v-actions">
          <button class="btn" style="padding:4px 10px; font-size:11px;" data-act="load"><i class="fas fa-folder-open"></i> Load</button>
          <button class="btn" style="padding:4px 10px; font-size:11px; color:var(--accent-danger);" data-act="del"><i class="fas fa-trash"></i></button>
        </div>
      `;
      row.querySelector('[data-act="load"]').onclick = () => {
        this.applyImportedState(v.state);
        this.closeModal("versions_modal_overlay");
        this.toast(`Loaded version "${v.name}" (undo restores your previous state)`, "success");
      };
      row.querySelector('[data-act="del"]').onclick = () => {
        const l = this.getVersions();
        l.splice(i, 1);
        this.setVersions(l);
        this.renderVersionsList();
      };
      container.appendChild(row);
    });
  },

  // ================= THEME & TOASTS & MODALS =================

  initTheme() {
    const saved = localStorage.getItem("vnovel_theme") || "dark";
    if (saved === "light") document.body.classList.add("light");
    this.updateThemeButton();
  },

  toggleTheme() {
    document.body.classList.toggle("light");
    localStorage.setItem("vnovel_theme", document.body.classList.contains("light") ? "light" : "dark");
    this.updateThemeButton();
    this.applyCanvasTheme();
  },

  updateThemeButton() {
    const btn = document.getElementById("btn_toggle_theme");
    if (!btn) return;
    const light = document.body.classList.contains("light");
    btn.innerHTML = light ? '<i class="fas fa-moon"></i>' : '<i class="fas fa-sun"></i>';
    btn.title = light ? "Switch to dark theme" : "Switch to light theme";
  },

  toast(msg, type = "") {
    const container = document.getElementById("toast_container");
    if (!container) return;
    const t = document.createElement("div");
    t.className = "toast " + type;
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  },

  openModal(id) { document.getElementById(id).style.display = "flex"; },
  closeModal(id) { document.getElementById(id).style.display = "none"; },
  openLLMModal() { this.openModal("llm_modal_overlay"); },
  closeLLMModal() { this.closeModal("llm_modal_overlay"); },

  escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  },

  // ================= LLM COPILOT =================

  async runScreenplayImporter() {
    const text = document.getElementById("llm_screenplay_input").value;
    const logs = document.getElementById("llm_console_logs");

    if (!text || !text.trim()) {
      this.toast("Paste screenplay text first.", "warning");
      return;
    }

    logs.innerHTML = `<div class="log-message warning">Processing screenplay... Running script-to-JSON compiler.</div>`;

    const apiKey = document.getElementById("llm_api_key_input").value.trim();

    if (apiKey) {
      try {
        const parsedJSON = await this.callLLMApi(apiKey, "screenplay", text);
        const created = this.applyParsedNarrativeGraph(parsedJSON);
        if (created.length === 0) {
          throw new Error("LLM response contained no usable nodes.");
        }
        logs.innerHTML = `<div class="log-message success">Inserted ${created.length} new nodes at your current canvas view — existing nodes untouched. The batch is selected, so you can drag it into place, then wire it to your story.</div>`;
      } catch (err) {
        logs.innerHTML = `<div class="log-message danger">API Error: ${err.message}. Falling back to Smart Compiler simulator.</div>`;
        this.runSimulatedScreenplayParser(text, logs);
      }
    } else {
      setTimeout(() => {
        this.runSimulatedScreenplayParser(text, logs);
      }, 1500);
    }
  },

  runSimulatedScreenplayParser(text, logs) {
    try {
      const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
      let nodes = {};
      let currentNodeId = 1000;
      let lastNodeId = null;
      let activeLocation = "Mysterious glade";
      let activeCharacters = new Set();

      let nodeDialogueAccumulator = [];

      const flushNode = () => {
        if (nodeDialogueAccumulator.length > 0) {
          const nodeId = `node_${currentNodeId++}`;
          nodes[nodeId] = {
            type: "passthrough",
            location: activeLocation,
            charactersPresent: Array.from(activeCharacters),
            text: nodeDialogueAccumulator.join("\n"),
            background: "",
            next: null
          };

          if (lastNodeId) {
            nodes[lastNodeId].next = nodeId;
          }
          lastNodeId = nodeId;
          nodeDialogueAccumulator = [];
          activeCharacters = new Set();
        }
      };

      lines.forEach(line => {
        if (line.startsWith("INT.") || line.startsWith("EXT.")) {
          flushNode();
          activeLocation = line.replace(/^(INT\.|EXT\.)/, "").trim();
          this.addVariable("locations", activeLocation);
        } else if (line.match(/^[A-Z\s]+$/)) {
          const char = line.trim();
          activeCharacters.add(char);
          this.addVariable("characters", char);
          nodeDialogueAccumulator.push(`{${char}}`);
        } else {
          if (nodeDialogueAccumulator.length > 0) {
            const lastIdx = nodeDialogueAccumulator.length - 1;
            if (nodeDialogueAccumulator[lastIdx].startsWith("{") && nodeDialogueAccumulator[lastIdx].endsWith("}")) {
              nodeDialogueAccumulator[lastIdx] = nodeDialogueAccumulator[lastIdx] + ": " + line;
            } else {
              nodeDialogueAccumulator.push(line);
            }
          } else {
            nodeDialogueAccumulator.push(line);
          }
        }
      });

      flushNode();

      const created = this.insertNarrativeNodes(nodes);
      logs.innerHTML = `<div class="log-message success"><strong>Simulation Success!</strong> Inserted ${created.length} new narrative nodes at your current canvas view — existing nodes untouched. The batch is selected, so you can drag it into place, then wire it to your story.</div>`;
    } catch (err) {
      logs.innerHTML = `<div class="log-message danger">Screenplay Import compilation failed: ${err.message}</div>`;
    }
  },

  async triggerLLMExpansion(node) {
    const apiKey = document.getElementById("llm_api_key_input").value.trim();
    const currentText = node.properties.text || "";

    node.properties.text = "Expanding dialogue using LLM Copilot...";
    node.setDirtyCanvas(true, true);

    if (apiKey) {
      try {
        const result = await this.callLLMApi(apiKey, "expand", currentText);
        node.properties.text = result;
        this.openInspector(node);
        this.checkpoint();
        this.toast("Dialogue expanded via live LLM!", "success");
      } catch (err) {
        this.toast("API error: " + err.message + ". Fallback simulation triggered.", "danger");
        this.runSimulatedExpansion(node, currentText);
      }
    } else {
      setTimeout(() => {
        this.runSimulatedExpansion(node, currentText);
      }, 1200);
    }
  },

  runSimulatedExpansion(node, text) {
    const lines = text.split("\n");
    let expandedLines = [];

    lines.forEach(line => {
      const match = line.match(/^\{?(\w+)\}?:\s*(.*)/s);
      if (match) {
        const char = match[1];
        const speech = match[2];
        expandedLines.push(`${char}: *takes a deep breath, looking around the rustling woods* "${speech} It feels like we aren't alone here..."`);
      } else {
        expandedLines.push(line + " *The shadows align closer in the dark.*");
      }
    });

    node.properties.text = expandedLines.join("\n");
    this.openInspector(node);
    this.checkpoint();
    this.toast("Narrative expanded (simulated creative mode)", "success");
  },

  runLogicDebugger() {
    const logs = document.getElementById("llm_console_logs");
    logs.innerHTML = `<div class="log-message warning">Scanning graph for loops, orphans, and broken variables...</div>`;

    setTimeout(() => {
      let issues = [];
      const nodes = this.graph._nodes;

      if (!nodes || nodes.length === 0) {
        logs.innerHTML = `<div class="log-message danger">Graph has no active nodes!</div>`;
        return;
      }

      nodes.forEach(node => {
        if (node.outputs && node.outputs.length > 0) {
          let hasConnection = false;
          node.outputs.forEach(out => {
            if (out.links && out.links.length > 0) hasConnection = true;
          });

          if (!hasConnection && node.type !== "vnovel/choice" && node.type !== "vnovel/traversal") {
            issues.push({
              level: 'warning',
              msg: `Orphan Node #${node.id} (${node.title}): Output terminal is unconnected. Playback will stop abruptly.`
            });
          }
        }

        const checkCondition = (cond, where) => {
          if (!cond) return;
          const matchItem = cond.match(/has_item\(['"](.+?)['"]\)/);
          if (matchItem) {
            const reqItem = matchItem[1];
            let itemFound = false;
            nodes.forEach(n => {
              if (n.properties && n.properties.rewardItems === reqItem) itemFound = true;
            });
            if (!itemFound) {
              issues.push({
                level: 'danger',
                msg: `Unresolvable condition in ${where}: item "${reqItem}" is never awarded by any dialogue node.`
              });
            }
          }
          const matchKw = cond.match(/has_knowledge\(['"](.+?)['"]\)/);
          if (matchKw) {
            const reqKw = matchKw[1];
            let kwFound = false;
            nodes.forEach(n => {
              if (n.properties && n.properties.rewardKnowledge === reqKw) kwFound = true;
            });
            if (!kwFound) {
              issues.push({
                level: 'danger',
                msg: `Dead lock warning in ${where}: diary flag "${reqKw}" is checked but never granted.`
              });
            }
          }
          const matchMission = cond.match(/mission_(?:active|done)\(['"](.+?)['"]\)/);
          if (matchMission) {
            const m = matchMission[1];
            if (!this.globalVars.missions.includes(m)) {
              issues.push({
                level: 'warning',
                msg: `${where} references mission "${m}" which doesn't exist in the Missions list.`
              });
            }
          }
        };

        if (node.type === "vnovel/logic_gate") {
          checkCondition(node.properties.condition, `Logic Node #${node.id}`);
        }
        if (node.type === "vnovel/choice") {
          (node.properties.choices || []).forEach((c, i) => checkCondition(c.condition, `Choice Node #${node.id} option ${i + 1}`));
        }
      });

      if (issues.length === 0) {
        logs.innerHTML = `<div class="log-message success"><strong>Logic debugger clean:</strong> No dead-ends or unachievable conditions found in graph flow schema. Ready to play!</div>`;
      } else {
        logs.innerHTML = issues.map(iss => `
          <div class="log-message ${iss.level === 'danger' ? 'danger' : 'warning'}">
            <strong>${iss.level.toUpperCase()}:</strong> ${iss.msg}
          </div>
        `).join('');
      }

    }, 800);
  },

  getSelectedProvider() {
    const sel = document.getElementById("llm_provider_select");
    return sel ? sel.value : "anthropic";
  },

  getSelectedModel() {
    const sel = document.getElementById("llm_model_select");
    return sel ? sel.value : "";
  },

  updateLLMModels() {
    const providerSelect = document.getElementById("llm_provider_select");
    const modelSelect = document.getElementById("llm_model_select");
    if (!providerSelect || !modelSelect) return;

    const provider = providerSelect.value;
    const models = this.MODELS[provider] || [];

    modelSelect.innerHTML = "";
    models.forEach(model => {
      const opt = document.createElement("option");
      opt.value = model.id;
      opt.textContent = model.name;
      modelSelect.appendChild(opt);
    });

    // Load saved model for this provider if it exists
    const savedModel = localStorage.getItem(`vnovel_llm_model_${provider}`);
    if (savedModel && models.some(m => m.id === savedModel)) {
      modelSelect.value = savedModel;
    } else if (models.length > 0) {
      modelSelect.value = models[0].id;
    }
    localStorage.setItem(`vnovel_llm_model_${provider}`, modelSelect.value);
  },

  getScreenplayPrompt(content) {
    return `You are a story compiler for a visual-novel node engine used to prototype a game. Convert the screenplay / premise below into ONE JSON object. Return ONLY raw JSON — no markdown fences, no commentary.

Schema:
{
  "vars": {
    "characters":   [{"name": "Hero", "info": "one-sentence background"}],
    "locations":    [{"name": "Dark Forest", "info": "..."}],
    "collectibles": [{"name": "rusty_key", "info": "..."}],
    "knowledge":    [{"name": "heard_rustle", "info": "..."}],
    "missions":     [{"name": "Find the Rusty Key", "info": "...", "required": true}]
  },
  "nodes": {
    "n1": {"type": "dialogue", "title": "Scene title", "location": "Dark Forest",
           "text": "Hero: A line of dialogue\\nNarrator: Narration line",
           "rewardItems": "", "rewardKnowledge": "", "startMission": "", "completeMission": "",
           "next": "n2"},
    "n2": {"type": "choice", "title": "Prompt shown to the player",
           "choices": [{"text": "Option label", "condition": "", "mission": "", "target": "n3"}]},
    "n3": {"type": "traversal", "title": "Maze name", "targetAccumulation": 50,
           "outcomes": [{"label": "Trap", "probability": 10, "description": "What happens", "target": "n5"}],
           "escape": "n4", "earlyExit": "n6"},
    "n4": {"type": "logic", "title": "Gate name", "condition": "has_item('rusty_key')",
           "truePath": "n7", "falsePath": "n8"}
  }
}

Rules:
- Define EVERY character, location, collectible, knowledge flag and mission you use in "vars", each with a short "info". Missions must set "required" true/false.
- Dialogue "text": one beat per line, "Name: line" format; lines without a name are narration. Every line of source dialogue must survive into some node.
- Conditions may only use: has_item('id'), has_knowledge('id'), mission_active('Name'), mission_done('Name') — with ids/names defined in "vars". Multiple checks in one string are ANDed.
- Missions: a choice option's "mission" field makes choosing it ACCEPT that mission; a dialogue node's "completeMission" completes it. Use these — wire at least one mission if the material supports it.
- Wire everything up: every node except endings should lead somewhere via next/target/escape/truePath/falsePath. Branches may converge on the same target node.
- Use collectible rewards (rewardItems) and knowledge (rewardKnowledge) to make conditions satisfiable.

Source material:
${content}`;
  },

  copyLLMPrompt() {
    const text = document.getElementById("llm_screenplay_input").value;
    if (!text || !text.trim()) {
      this.toast("Paste or write a screenplay in the textbox first to generate a full prompt.", "warning");
      return;
    }
    const prompt = this.getScreenplayPrompt(text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(prompt).then(
        () => this.toast("Prompt copied to clipboard!", "success"),
        (err) => this.toast("Failed to copy: " + err, "danger")
      );
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = prompt;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
        this.toast("Prompt copied to clipboard!", "success");
      } catch (err) {
        this.toast("Failed to copy to clipboard", "danger");
      }
      document.body.removeChild(textarea);
    }
  },

  async callLLMApi(key, action, content) {
    let prompt = "";
    if (action === "screenplay") {
      prompt = this.getScreenplayPrompt(content);
    } else {
      prompt = `Flesh out this visual novel dialogue to make it engaging and descriptive. Keep the "Name: line" format intact for each spoken line:
${content}`;
    }

    const provider = this.getSelectedProvider();
    const resultText = provider === "anthropic"
      ? await this.callAnthropicApi(key, prompt)
      : await this.callGeminiApi(key, prompt);

    if (action === "screenplay") {
      const jsonMatch = resultText.match(/{[\s\S]*}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error("Could not parse JSON block from API response.");
    }

    return resultText;
  },

  async callAnthropicApi(key, prompt) {
    const model = this.getSelectedModel() || "claude-3-5-sonnet-latest";
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // Required CORS opt-in for calling the Anthropic API from a browser
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      let detail = "";
      try {
        const errData = await response.json();
        detail = errData.error && errData.error.message ? ` - ${errData.error.message}` : "";
      } catch (e) { /* non-JSON error body */ }
      throw new Error(`Anthropic API failed with code: ${response.status}${detail}`);
    }

    const data = await response.json();
    if (data.stop_reason === "refusal") {
      throw new Error("Anthropic API declined the request (refusal).");
    }
    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) {
      throw new Error("Anthropic API returned no text content.");
    }
    return textBlock.text;
  },

  async callGeminiApi(key, prompt) {
    const model = this.getSelectedModel() || "gemini-2.5-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini API failed with code: ${response.status}`);
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  },

  applyParsedNarrativeGraph(parsed) {
    const varCount = this.applyParsedVars(parsed && parsed.vars);
    const nodes = this.extractNarrativeNodes(parsed);
    const created = this.insertNarrativeNodes(nodes);
    if (varCount > 0) {
      this.toast(`LLM defined ${varCount} new characters/props/missions — see the sidebar`, "success");
    }
    return created;
  },

  // Ingest LLM-defined vars: entries can be plain strings or
  // {name, info, required} objects. Info lands in varMeta (double-click a tag).
  applyParsedVars(vars) {
    if (!vars || typeof vars !== "object") return 0;
    let count = 0;
    ["characters", "locations", "collectibles", "knowledge", "missions"].forEach(cat => {
      const list = vars[cat];
      if (!Array.isArray(list)) return;
      list.forEach(item => {
        const name = typeof item === "string" ? item : (item && item.name);
        if (!name || typeof name !== "string") return;
        if (!this.globalVars[cat].includes(name)) {
          this.globalVars[cat].push(name);
          count++;
        }
        if (item && typeof item === "object") {
          const meta = this.getMeta(cat, name);
          if (item.info) meta.info = String(item.info);
          if (cat === "missions" && item.required !== undefined) meta.required = !!item.required;
        }
      });
    });
    if (count > 0) {
      this.renderGlobalTags();
      this.updateInspectorAutocompletes();
    }
    return count;
  },

  // Accept both {nodes: {...}} and the chapters-wrapped schema
  // {chapters: {chapter_1: {nodes: {...}}, ...}} that LLMs sometimes produce.
  extractNarrativeNodes(parsed) {
    if (!parsed) return {};
    if (parsed.nodes) return parsed.nodes;
    if (parsed.chapters) {
      const merged = {};
      Object.values(parsed.chapters).forEach(chapter => {
        if (chapter && chapter.nodes) Object.assign(merged, chapter.nodes);
      });
      return merged;
    }
    return {};
  },

  // Insert parsed narrative nodes into the EXISTING graph (never clears it).
  // New nodes are laid out at the current view position and left selected so
  // the writer can drag the whole batch to wherever it belongs.
  insertNarrativeNodes(narrativeNodes) {
    const keys = Object.keys(narrativeNodes || {});
    if (keys.length === 0) return [];

    const ds = this.canvas.ds;
    const originX = (this.canvas.canvas.width / 2) / ds.scale - ds.offset[0] - 300;
    const originY = (this.canvas.canvas.height / 2) / ds.scale - ds.offset[1] - 100;

    const createdNodes = {};
    const createdList = [];
    let xOffset = originX;
    let yOffset = originY;
    let col = 0;

    const normType = (t) => {
      t = String(t || "").toLowerCase();
      if (t === "choice") return "choice";
      if (t === "traversal") return "traversal";
      if (t === "logic" || t === "logic_gate" || t === "gate") return "logic";
      // passthrough, dialogue, AND anything unrecognized becomes dialogue so
      // no imported content is silently dropped
      return "dialogue";
    };

    // First pass: create all LiteGraph node instances (IDs are assigned by
    // the graph — never forced from key names, which can collide with
    // existing nodes and corrupt links)
    keys.forEach(nodeKey => {
      const data = narrativeNodes[nodeKey] || {};
      const t = normType(data.type);
      let lgNode = null;

      if (t === "choice") {
        lgNode = LiteGraph.createNode("vnovel/choice");
        lgNode.properties.choices = (data.choices || []).map(c => ({
          text: c.text || "Option",
          condition: c.condition || "",
          mission: c.mission || ""
        }));
        lgNode.updateChoiceOutputs();
      } else if (t === "traversal") {
        lgNode = LiteGraph.createNode("vnovel/traversal");
        lgNode.properties.targetAccumulation = parseInt(data.targetAccumulation) || 50;
        lgNode.properties.outcomes = (data.outcomes || []).map(o => ({
          label: o.label || "Event",
          probability: o.probability !== undefined ? parseFloat(o.probability) : 10,
          description: o.description || ""
        }));
        lgNode.updateOutputs();
      } else if (t === "logic") {
        lgNode = LiteGraph.createNode("vnovel/logic_gate");
        lgNode.properties.condition = data.condition || "";
      } else {
        lgNode = LiteGraph.createNode("vnovel/passthrough");
        lgNode.properties.location = data.location || "Unknown";
        lgNode.properties.text = data.text || "";
        lgNode.properties.background = data.background || "";
        lgNode.properties.rewardItems = data.rewardItems || "";
        lgNode.properties.rewardKnowledge = data.rewardKnowledge || "";
        lgNode.properties.startMission = data.startMission || "";
        lgNode.properties.completeMission = data.completeMission || "";
        if (data.isChapterStart) lgNode.properties.isChapterStart = true;
      }

      if (data.title) {
        lgNode.properties.title = data.title;
        lgNode.title = data.title;
      }

      lgNode.pos = [xOffset, yOffset];
      this.graph.add(lgNode);
      createdNodes[nodeKey] = lgNode;
      createdList.push(lgNode);

      xOffset += 280;
      if (++col % 4 === 0) {
        xOffset = originX;
        yOffset += 220;
      }
    });

    // Second pass: wire connections between the newly created nodes.
    // Slot layouts must match the runtime: choice = one slot per option;
    // traversal = escape(0), outcomes(1..n), earlyExit(n+1); logic = true(0)/false(1).
    keys.forEach(nodeKey => {
      const data = narrativeNodes[nodeKey] || {};
      const sourceNode = createdNodes[nodeKey];
      if (!sourceNode) return;
      const t = normType(data.type);
      const link = (slot, targetKey) => {
        const targetNode = targetKey && createdNodes[targetKey];
        if (targetNode) sourceNode.connect(slot, targetNode, 0);
      };

      if (t === "choice") {
        (data.choices || []).forEach((choice, choiceIdx) => link(choiceIdx, choice.target));
      } else if (t === "traversal") {
        link(0, data.escape || data.next);
        (data.outcomes || []).forEach((o, i) => link(i + 1, o.target));
        link((data.outcomes || []).length + 1, data.earlyExit);
      } else if (t === "logic") {
        link(0, data.truePath || data.trueTarget);
        link(1, data.falsePath || data.falseTarget);
      } else {
        link(0, data.next);
      }
    });

    if (this.canvas.selectNodes) {
      this.canvas.selectNodes(createdList);
    }
    if (createdList.length > 0) {
      this.canvas.centerOnNode(createdList[0]);
    }

    this.renderBookmarks();
    this.saveToLocalStorage();
    this.checkpoint();
    this.canvas.draw(true, true);
    return createdList;
  },

  // ================= DEMO PROJECT =================

  loadDemoProject() {
    if (this.loadFromLocalStorage()) return;
    this.buildTemplateProject();
  },

  // Starter template: a tiny complete story that uses every node type.
  // Used on first run and by "New > Starter Template".
  buildTemplateProject() {
    this.graph.clear();

    this.globalVars = {
      characters: ["Hero", "Goblin", "Wizard", "Narrator"],
      locations: ["Dark Forest", "Castle Keep", "Secret Cave"],
      collectibles: ["rusty_key", "healing_potion", "ancient_coin"],
      knowledge: ["heard_rustle", "met_wizard", "found_secret"],
      missions: ["Find the Rusty Key"]
    };
    this.varMeta = {
      missions: {
        "Find the Rusty Key": { info: "An old iron key is said to be buried near the gate roots.", required: false }
      }
    };

    // Node 1: Intro Dialogue
    const n1 = LiteGraph.createNode("vnovel/passthrough");
    n1.id = 101;
    n1.properties.title = "Act I: Whispers in the Woods";
    n1.properties.location = "Dark Forest";
    n1.properties.text = "Hero: Did you hear that?\nGoblin: *cringes in the shadow* Run! Run before they notice us!";
    n1.properties.rewardKnowledge = "heard_rustle";
    n1.properties.isChapterStart = true;
    n1.pos = [80, 150];
    this.graph.add(n1);

    // Node 2: Choices Branch (option 2 accepts a mission)
    const n2 = LiteGraph.createNode("vnovel/choice");
    n2.id = 102;
    n2.properties.title = "Fateful Encounter";
    n2.properties.choices = [
      { text: "Fight the Goblin companion", condition: "", mission: "" },
      { text: "Search for the gate key", condition: "has_knowledge('heard_rustle')", mission: "Find the Rusty Key" }
    ];
    n2.updateChoiceOutputs();
    n2.pos = [420, 150];
    this.graph.add(n2);

    // Node 3: Combat
    const n3 = LiteGraph.createNode("vnovel/passthrough");
    n3.id = 103;
    n3.properties.title = "Sudden Skirmish";
    n3.properties.location = "Dark Forest";
    n3.properties.text = "Goblin: Why do you draw your sword? Help! *The fight starts*";
    n3.properties.rewardItems = "ancient_coin";
    n3.pos = [760, 50];
    this.graph.add(n3);

    // Node 4: The gate (completes the mission)
    const n4 = LiteGraph.createNode("vnovel/passthrough");
    n4.id = 104;
    n4.properties.title = "Undergrowth Gate";
    n4.properties.location = "Dark Forest";
    n4.properties.text = "Narrator: A mossy iron gate blocks the pass. Buried in the roots, you spot a rusty iron key.\nHero: Let's grab this.";
    n4.properties.rewardItems = "rusty_key";
    n4.properties.completeMission = "Find the Rusty Key";
    n4.pos = [760, 280];
    this.graph.add(n4);

    // Node 5: Traversal Maze
    const n5 = LiteGraph.createNode("vnovel/traversal");
    n5.id = 105;
    n5.properties.title = "Forgotten Maze Loop";
    n5.properties.targetAccumulation = 50;
    n5.properties.outcomes = [
      { label: "Become Monster", probability: 10, description: "You got bitten by a shadow creature and mutated!" },
      { label: "Spike Trap (Die)", probability: 5, description: "You stepped on a pressure plate and fell into spikes." }
    ];
    n5.updateOutputs();
    n5.pos = [1080, 280];
    this.graph.add(n5);

    // Node 6: Escape End Node
    const n6 = LiteGraph.createNode("vnovel/passthrough");
    n6.id = 106;
    n6.properties.title = "Glade of Lights";
    n6.properties.location = "Secret Cave";
    n6.properties.text = "Wizard: Ah, travelers, you managed to bypass the traps! Welcome to the sacred ruins.";
    n6.pos = [1420, 230];
    this.graph.add(n6);

    // Node 7: Mutation End Node
    const n7 = LiteGraph.createNode("vnovel/passthrough");
    n7.id = 107;
    n7.properties.title = "Mutated Ending";
    n7.properties.location = "Secret Cave";
    n7.properties.text = "Hero: Argh! The dark corruption... it's taking over! I've become a monster of the forest...";
    n7.pos = [1420, 450];
    this.graph.add(n7);

    // Node 8: Death End Node
    const n8 = LiteGraph.createNode("vnovel/passthrough");
    n8.id = 108;
    n8.properties.title = "Death Ending";
    n8.properties.location = "Dark Forest";
    n8.properties.text = "Narrator: The spikes pierced deep. Your journey ends here in the dark.";
    n8.pos = [1420, 40];
    this.graph.add(n8);

    // Node 9: Early exit path
    const n9 = LiteGraph.createNode("vnovel/passthrough");
    n9.id = 109;
    n9.properties.title = "The Long Way Around";
    n9.properties.location = "Dark Forest";
    n9.properties.text = "Narrator: You back away from the maze. Slower, but alive. The forest path stretches ahead.";
    n9.pos = [1080, 520];
    this.graph.add(n9);

    // Node 10: Logic gate — did you pick up the coin in the fight?
    const n10 = LiteGraph.createNode("vnovel/logic_gate");
    n10.id = 110;
    n10.properties.title = "Carrying the coin?";
    n10.properties.condition = "has_item('ancient_coin')";
    n10.pos = [1080, 40];
    this.graph.add(n10);

    // Connections
    n1.connect(0, n2, 0);  // Intro -> Choice
    n2.connect(0, n3, 0);  // Option 1 -> Combat
    n2.connect(1, n4, 0);  // Option 2 (mission) -> Gate
    n3.connect(0, n10, 0); // Combat -> Logic gate
    n10.connect(0, n6, 0); // Gate TRUE -> Glade (converges with maze success!)
    n10.connect(1, n8, 0); // Gate FALSE -> Death ending (converges with spike trap!)
    n4.connect(0, n5, 0);  // Gate -> Maze
    n5.connect(0, n6, 0);  // Maze Success -> Glade (many-to-one input)
    n5.connect(1, n7, 0);  // Become Monster -> Mutation Ending
    n5.connect(2, n8, 0);  // Spike Trap -> Death Ending (many-to-one input)
    n5.connect(3, n9, 0);  // Early Exit -> Long way around

    this.renderGlobalTags();
    this.renderBookmarks();
    this.canvas.draw(true, true);
  },

  // ================= EVENT HANDLERS =================

  registerEventHandlers() {
    const on = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.onclick = fn;
    };

     // Header buttons
    on("btn_new_graph", () => this.newGraph());
    on("btn_versions", () => { this.renderVersionsList(); this.openModal("versions_modal_overlay"); });
    on("btn_import_project", () => this.openModal("import_modal_overlay"));
    on("btn_export_project", () => this.openModal("export_modal_overlay"));
    on("btn_publish", () => this.publishStory());
    on("btn_open_llm_copilot", () => this.openLLMModal());
    on("btn_toggle_theme", () => this.toggleTheme());
    on("btn_help", () => this.openModal("help_modal_overlay"));
    on("btn_start_play", () => this.startPlayback());

    // Modal actions
    on("btn_new_empty", () => this.newEmptyGraph());
    on("btn_new_template", () => this.newTemplateGraph());
    on("btn_close_llm_modal", () => this.closeLLMModal());
    on("btn_llm_copy_prompt", () => this.copyLLMPrompt());
    on("btn_llm_run_screenplay", () => this.runScreenplayImporter());
    on("btn_llm_run_debugger", () => this.runLogicDebugger());
    on("btn_do_import", () => this.doImport());
    on("btn_do_export", () => this.doExport());
    on("btn_save_version", () => this.saveVersion());
    on("btn_save_item_info", () => this.saveItemModal());

    // Undo / redo buttons on the palette
    on("btn_undo", () => this.undo());
    on("btn_redo", () => this.redo());

    // Asset handling mode (embed vs reference by path)
    const assetSelect = document.getElementById("asset_mode_select");
    if (assetSelect) {
      assetSelect.value = this.getAssetMode();
      assetSelect.addEventListener("change", () => {
        localStorage.setItem("vnovel_asset_mode", assetSelect.value);
        this.toast(assetSelect.value === "embed"
          ? "Picked files will be embedded into the project (fully portable)."
          : "Picked files will be referenced as assets/<name> — keep an assets folder next to the editor and published HTML.");
      });
    }

    // Save/Load LLM key and provider in localStorage
    const apiKeyInput = document.getElementById("llm_api_key_input");
    if (apiKeyInput) {
      const savedKey = localStorage.getItem("vnovel_llm_api_key");
      if (savedKey) apiKeyInput.value = savedKey;
      apiKeyInput.addEventListener("input", () => {
        localStorage.setItem("vnovel_llm_api_key", apiKeyInput.value.trim());
      });
    }

    const providerSelect = document.getElementById("llm_provider_select");
    if (providerSelect) {
      const savedProvider = localStorage.getItem("vnovel_llm_provider");
      if (savedProvider) providerSelect.value = savedProvider;
      providerSelect.addEventListener("change", () => {
        localStorage.setItem("vnovel_llm_provider", providerSelect.value);
        this.updateLLMModels();
      });
    }

    const modelSelect = document.getElementById("llm_model_select");
    if (modelSelect) {
      modelSelect.addEventListener("change", () => {
        const provider = providerSelect ? providerSelect.value : "anthropic";
        localStorage.setItem(`vnovel_llm_model_${provider}`, modelSelect.value);
      });
    }

    // Project title
    const titleInput = document.getElementById("project_title_input");
    titleInput.addEventListener("input", () => {
      this.projectTitle = titleInput.value || "Untitled Story";
      this.schedulePersist();
    });

    // Node palette buttons
    document.querySelectorAll(".palette-btn[data-nodetype]").forEach(btn => {
      btn.onclick = () => {
        const c = this.viewCenter();
        // Slight jitter so repeated adds don't stack perfectly
        this.addNodeAt(btn.dataset.nodetype, [c[0] - 120 + Math.random() * 60, c[1] - 60 + Math.random() * 60]);
      };
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      const t = e.target;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

      if (e.key === "Escape") {
        // Close any open modal first
        const openModals = document.querySelectorAll(".modal-overlay");
        for (const m of openModals) {
          if (m.style.display === "flex") { m.style.display = "none"; return; }
        }
        if (!this.gamePlaying && !typing) this.closeInspector();
        return;
      }

      if (this.gamePlaying || typing) return;

      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.deleteSelection();
      } else if (ctrl && key === "z" && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if (ctrl && (key === "y" || (key === "z" && e.shiftKey))) {
        e.preventDefault();
        this.redo();
      } else if (ctrl && key === "d") {
        e.preventDefault();
        this.duplicateSelection();
      }
    });

    // Close Drawer when clicking EMPTY canvas space. A double-click on a node
    // also fires plain click events, so hit-test the graph first — otherwise
    // the click would instantly close the inspector the dblclick just opened.
    const self = this;
    const canvasContainer = document.getElementById("canvas_container");
    canvasContainer.onclick = (e) => {
      if (e.target.id !== "graph_canvas") return;
      const pos = self.canvas.convertEventToCanvasOffset(e);
      const hitNode = self.graph.getNodeOnPos(pos[0], pos[1]);
      if (!hitNode) {
        self.closeInspector();
      }
    };

    // Click outside a modal card closes it
    document.querySelectorAll(".modal-overlay").forEach(overlay => {
      overlay.addEventListener("mousedown", (e) => {
        if (e.target === overlay) overlay.style.display = "none";
      });
    });
  }
};
