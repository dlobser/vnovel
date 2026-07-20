// App initialization & State Management
window.addEventListener('DOMContentLoaded', () => {
  VNovelApp.init();
});

const VNovelApp = {
  graph: null,
  canvas: null,
  activeNode: null,
  
  // Decoupled Game Engine State
  gameState: {
    currentChunkId: null,
    inventory: new Set(),
    diaryKnowledge: new Set(),
    traversalScores: {}, // node_id -> score
    currentLogHistory: [],
    isPlaying: false
  },

  // Globals Lists for Autocomplete and Variables Quick-Add
  globalVars: {
    characters: ["Hero", "Goblin", "Wizard", "Narrator"],
    locations: ["Dark Forest", "Castle Keep", "Secret Cave"],
    collectibles: ["rusty_key", "healing_potion", "ancient_coin"],
    knowledge: ["heard_rustle", "met_wizard", "found_secret"]
  },

  // Bookmarks list
  bookmarks: [],

  // Audio system state (simulation logs)
  audioState: {
    currentLoop: null,
    crossfading: false
  },

  // Initialize Application
  init() {
    this.initGraph();
    this.initUI();
    this.registerEventHandlers();
    this.loadDemoProject();
    
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

    // Create LiteGraph Canvas
    const canvasEl = document.getElementById("graph_canvas");
    this.canvas = new LGraphCanvas(canvasEl, this.graph);

    // Styling the canvas themes
    this.canvas.background_color = "#0f1015";
    this.canvas.grid_color = "#181a24";
    this.canvas.connections_width = 3;
    this.canvas.render_shadows = true;
    this.canvas.show_info = false;

    // Match the canvas backing store to its on-screen size (otherwise it stays
    // at the 300x150 default and CSS stretches it, making everything look huge)
    this.resizeCanvas();
    window.addEventListener("resize", () => this.resizeCanvas());

    // Hook double-click to open Context Inspector
    const self = this;
    this.canvas.onNodeDblClicked = function(node) {
      self.openInspector(node);
    };

    this.registerCustomNodes();

    // Run the graph rendering loop
    this.graph.start();
  },

  resizeCanvas() {
    if (!this.canvas) return;
    const container = document.getElementById("canvas_container");
    if (!container) return;
    this.canvas.resize(container.clientWidth, container.clientHeight);
  },

  // Register Custom VNovel Node Archetypes
  registerCustomNodes() {
    const self = this;

    // A. PASSTHROUGH NARRATIVE NODE
    function PassthroughNode() {
      this.addInput("In", LiteGraph.ACTION);
      this.addOutput("Out", LiteGraph.ACTION);
      
      this.properties = {
        title: "Dialogue",
        location: "Dark Forest",
        charactersPresent: "Hero, Goblin",
        text: "{Hero}: Did you hear that?\n{Goblin}: Run!",
        audioLoop: "ambient_wind.mp3",
        audioOneShot: "",
        background: "forest_night.png",
        rewardItems: "",
        rewardKnowledge: "",
        isChapterStart: false
      };
      
      this.size = [240, 110];
    }
    
    PassthroughNode.title = "Passthrough Node";
    PassthroughNode.title_color = "#3b82f6"; // Blue Accent
    
    PassthroughNode.prototype.onDrawForeground = function(ctx) {
      if (this.flags.collapsed) return;
      ctx.font = "10px Inter, sans-serif";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(`Loc: ${this.properties.location}`, 12, 45);
      ctx.fillText(`Chars: ${this.properties.charactersPresent}`, 12, 60);
      
      let textSnippet = this.properties.text || "";
      if (textSnippet.length > 30) textSnippet = textSnippet.substring(0, 27) + "...";
      ctx.fillStyle = "#e2e8f0";
      ctx.fillText(`"${textSnippet}"`, 12, 80);
      
      if (this.properties.isChapterStart) {
        ctx.fillStyle = "#10b981";
        ctx.fillText("★ Bookmark Entry", 12, 95);
      }
    };

    LiteGraph.registerNodeType("vnovel/passthrough", PassthroughNode);

    // B. CHOICE NODE
    function ChoiceNode() {
      this.addInput("In", LiteGraph.ACTION);
      this.properties = {
        title: "Path Selection",
        choices: [
          { text: "Fight the Goblin", condition: "" },
          { text: "Unlock the hidden gate", condition: "has_item('rusty_key')" }
        ]
      };
      this.size = [240, 120];
      this.updateChoiceOutputs();
    }
    
    ChoiceNode.title = "Choice Node";
    ChoiceNode.title_color = "#8b5cf6"; // Purple Accent
    
    ChoiceNode.prototype.updateChoiceOutputs = function() {
      // Synchronize output slots with properties choices list
      const neededOutputs = this.properties.choices.length;
      
      // Clear existing outputs that might exceed
      while (this.outputs && this.outputs.length > neededOutputs) {
        this.removeOutput(this.outputs.length - 1);
      }
      
      // Add missing outputs
      for (let i = 0; i < neededOutputs; i++) {
        const choiceText = this.properties.choices[i].text || `Choice ${i+1}`;
        const truncated = choiceText.length > 20 ? choiceText.substring(0, 17) + "..." : choiceText;
        
        if (this.outputs && this.outputs[i]) {
          this.outputs[i].label = truncated;
        } else {
          this.addOutput(truncated, LiteGraph.ACTION);
        }
      }
    };
    
    ChoiceNode.prototype.onDrawForeground = function(ctx) {
      if (this.flags.collapsed) return;
      ctx.font = "10px Inter, sans-serif";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(`Options Count: ${this.properties.choices.length}`, 12, 45);
    };

    LiteGraph.registerNodeType("vnovel/choice", ChoiceNode);

    // C. TRAVERSAL (DICE ROLL) NODE
    function TraversalNode() {
      this.addInput("In", LiteGraph.ACTION);
      this.properties = {
        title: "Dice Maze Challenge",
        targetAccumulation: 100,
        currentAccumulation: 0,
        outcomes: [
          { label: "Become Monster", probability: 10, description: "You got bitten by a shadow creature and mutated!" },
          { label: "Spike Trap (Die)", probability: 5, description: "You stepped on a pressure plate and fell into spikes." }
        ]
      };
      this.size = [260, 120];
      this.updateOutputs();
    }
    
    TraversalNode.title = "Traversal Node";
    TraversalNode.title_color = "#f59e0b"; // Orange Accent
    
    TraversalNode.prototype.updateOutputs = function() {
      const neededCount = this.properties.outcomes.length + 1; // outcomes + Escape slot
      
      while (this.outputs && this.outputs.length > neededCount) {
        this.removeOutput(this.outputs.length - 1);
      }
      
      // Out 0: Escape
      if (this.outputs && this.outputs[0]) {
        this.outputs[0].label = "🎉 Escape / Success";
      } else {
        this.addOutput("🎉 Escape / Success", LiteGraph.ACTION);
      }
      
      // Rest of slots match outcome paths
      for (let i = 0; i < this.properties.outcomes.length; i++) {
        const outName = this.properties.outcomes[i].label || `Outcome ${i+1}`;
        const slotIdx = i + 1;
        if (this.outputs && this.outputs[slotIdx]) {
          this.outputs[slotIdx].label = outName;
        } else {
          this.addOutput(outName, LiteGraph.ACTION);
        }
      }
    };

    TraversalNode.prototype.onDrawForeground = function(ctx) {
      if (this.flags.collapsed) return;
      ctx.font = "10px Inter, sans-serif";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(`Target Score: ${this.properties.targetAccumulation}`, 12, 45);
      
      let yOffset = 60;
      this.properties.outcomes.forEach((out) => {
        const chance = out.probability !== undefined ? out.probability : 10;
        ctx.fillText(`• ${out.label}: ${chance}%`, 12, yOffset);
        yOffset += 15;
      });
      
      const neededHeight = yOffset + 15;
      if (this.size[1] < neededHeight) {
        this.size[1] = neededHeight;
      }
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
    LogicGateNode.title_color = "#10b981"; // Emerald green
    
    LogicGateNode.prototype.onDrawForeground = function(ctx) {
      if (this.flags.collapsed) return;
      ctx.font = "10px Inter, sans-serif";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText("Evaluates variable conditions", 12, 45);
      let condStr = this.properties.condition;
      if (condStr.length > 25) condStr = condStr.substring(0, 22) + "...";
      ctx.fillStyle = "#34d399";
      ctx.fillText(`Check: ${condStr}`, 12, 60);
    };

    const getMenuOptionsHelper = function(canvas) {
      const node = this;
      return [
        {
          content: "Play from here",
          callback: () => {
            self.startPlayback(node);
          }
        }
      ];
    };

    PassthroughNode.prototype.getMenuOptions = getMenuOptionsHelper;
    ChoiceNode.prototype.getMenuOptions = getMenuOptionsHelper;
    TraversalNode.prototype.getMenuOptions = getMenuOptionsHelper;
    LogicGateNode.prototype.getMenuOptions = getMenuOptionsHelper;

    LiteGraph.registerNodeType("vnovel/logic_gate", LogicGateNode);
  },

  // 2. UI Panels Rendering and Management
  initUI() {
    this.renderGlobalTags();
    this.renderBookmarks();
    this.closeInspector();
  },

  renderGlobalTags() {
    const listContainer = document.getElementById("global_vars_list");
    if (!listContainer) return;
    listContainer.innerHTML = "";

    const categories = [
      { key: 'characters', label: 'Characters', cssClass: 'character' },
      { key: 'locations', label: 'Locations', cssClass: 'location' },
      { key: 'collectibles', label: 'Collectibles', cssClass: 'collectible' },
      { key: 'knowledge', label: 'Knowledge (Diary)', cssClass: 'knowledge' }
    ];

    categories.forEach(cat => {
      const section = document.createElement("div");
      section.className = "list-section";
      section.innerHTML = `
        <div class="section-title">
          <span>${cat.label}</span>
          <button class="section-add-btn" onclick="VNovelApp.promptAddVariable('${cat.key}')">
            <i class="fas fa-plus"></i> +
          </button>
        </div>
        <div class="tag-list" id="tag_list_${cat.key}"></div>
      `;
      listContainer.appendChild(section);

      const tagContainer = section.querySelector(`#tag_list_${cat.key}`);
      this.globalVars[cat.key].forEach(val => {
        const tag = document.createElement("span");
        tag.className = `variable-tag ${cat.cssClass}`;
        tag.innerHTML = `
          ${val}
          <span class="remove-tag" onclick="VNovelApp.removeVariable('${cat.key}', '${val}')">&times;</span>
        `;
        tagContainer.appendChild(tag);
      });
    });
  },

  promptAddVariable(category) {
    const input = prompt(`Enter new global item name for ${category}:`);
    if (input && input.trim()) {
      this.addVariable(category, input.trim());
    }
  },

  addVariable(category, name) {
    if (!this.globalVars[category].includes(name)) {
      this.globalVars[category].push(name);
      this.renderGlobalTags();
      this.updateInspectorAutocompletes();
      this.saveToLocalStorage();
    }
  },

  removeVariable(category, name) {
    this.globalVars[category] = this.globalVars[category].filter(v => v !== name);
    this.renderGlobalTags();
    this.updateInspectorAutocompletes();
    this.saveToLocalStorage();
  },

  renderBookmarks() {
    const container = document.getElementById("bookmarks_list");
    if (!container) return;
    container.innerHTML = "";

    // Sync bookmarks from nodes with properties.isChapterStart
    this.bookmarks = [];
    const nodesList = this.graph._nodes || [];
    
    nodesList.forEach(node => {
      if (node.properties && node.properties.isChapterStart) {
        this.bookmarks.push({
          nodeId: node.id,
          title: node.properties.title || `Node #${node.id}`,
          location: node.properties.location || "Unknown Location"
        });
      }
    });

    if (this.bookmarks.length === 0) {
      container.innerHTML = `<div style="font-size:12px; color:var(--text-dark); font-style:italic;">No active chapters bookmarked. Double click a Passthrough node to bookmark it.</div>`;
      return;
    }

    this.bookmarks.forEach(bm => {
      const el = document.createElement("div");
      el.className = "bookmark-item";
      el.innerHTML = `
        <div>
          <strong style="color:#fff;">${bm.title}</strong>
          <div style="font-size:10px; color:var(--text-dark); margin-top:2px;">${bm.location}</div>
        </div>
        <i class="fas fa-chevron-right" style="font-size:10px; color:var(--accent-primary);"></i>
      `;
      el.onclick = () => {
        const node = this.graph.getNodeById(bm.nodeId);
        if (node) {
          this.canvas.centerOnNode(node);
          this.canvas.selectNode(node);
          this.openInspector(node);
        }
      };
      container.appendChild(el);
    });
  },

  // 3. Right Panel Inspector Drawer Logic
  openInspector(node) {
    this.activeNode = node;
    const drawer = document.getElementById("inspector_drawer");
    const container = document.getElementById("inspector_content");
    drawer.classList.remove("collapsed");

    container.innerHTML = "";

    // Header Info
    const nodeHeader = document.createElement("div");
    nodeHeader.style.marginBottom = "15px";
    nodeHeader.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
        <div>
          <h3 style="font-family:var(--font-display); font-size:16px; margin-bottom:4px;">Node Configuration</h3>
          <span style="font-size:11px; color:var(--accent-primary); text-transform:uppercase; font-weight:600;">Type: ${node.type}</span>
        </div>
        <button class="btn btn-primary" id="btn_play_from_here" style="padding: 6px 12px; font-size: 11px; background: linear-gradient(135deg, var(--accent-primary), var(--accent-success));">
          <i class="fas fa-play" style="font-size: 10px;"></i> Play from Here
        </button>
      </div>
    `;
    container.appendChild(nodeHeader);

    // Form inputs based on type
    if (node.type === "vnovel/passthrough") {
      this.renderPassthroughInspector(node, container);
    } else if (node.type === "vnovel/choice") {
      this.renderChoiceInspector(node, container);
    } else if (node.type === "vnovel/traversal") {
      this.renderTraversalInspector(node, container);
    } else if (node.type === "vnovel/logic_gate") {
      this.renderLogicGateInspector(node, container);
    }

    const playBtn = nodeHeader.querySelector("#btn_play_from_here");
    if (playBtn) {
      playBtn.onclick = () => {
        // Auto-save currently active inputs
        const saveBtn = container.querySelector("#btn_save_inspector, #btn_save_choices, #btn_save_traversal, #btn_save_logic_gate");
        if (saveBtn) {
          const oldAlert = window.alert;
          window.alert = () => {}; // suppress success alert
          try {
            saveBtn.click();
          } catch (e) {
            console.error("Auto-save failed", e);
          } finally {
            window.alert = oldAlert;
          }
        }
        this.startPlayback(node);
      };
    }
  },

  closeInspector() {
    this.activeNode = null;
    const drawer = document.getElementById("inspector_drawer");
    if (drawer) {
      drawer.classList.add("collapsed");
    }
  },

  // PASSTHROUGH DRAWER PANEL
  renderPassthroughInspector(node, container) {
    const form = document.createElement("div");
    form.className = "inspector-scroll";
    form.style.padding = "0";
    form.innerHTML = `
      <div class="form-group">
        <label>Node Title</label>
        <input type="text" class="input-text" id="node_prop_title" value="${node.properties.title || ''}">
      </div>

      <div class="form-group">
        <label>Bookmark as Chapter Entry Point?</label>
        <div style="display:flex; align-items:center; gap:10px; margin-top:4px;">
          <input type="checkbox" id="node_prop_chapter" ${node.properties.isChapterStart ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
          <span style="font-size:12px; color:var(--text-muted);">Show in quick-jump Bookmarks list</span>
        </div>
      </div>

      <div class="form-group">
        <label>Location</label>
        <select class="select-input" id="node_prop_location">
          ${this.globalVars.locations.map(loc => `<option value="${loc}" ${node.properties.location === loc ? 'selected' : ''}>${loc}</option>`).join('')}
        </select>
      </div>

      <div class="form-group">
        <label>Characters Present (comma separated)</label>
        <input type="text" class="input-text" id="node_prop_characters" value="${node.properties.charactersPresent || ''}">
        <div id="quick_add_char_bubble" class="quick-add-bubble"></div>
      </div>

      <div class="form-group">
        <label>Dialogue / Action Text</label>
        <div class="editor-container">
          <textarea class="textarea-input dialogue-textarea" id="node_prop_text" placeholder="Format: {CharacterName}: Speech dialog line...">${node.properties.text || ''}</textarea>
          <div class="autocomplete-menu" id="autocomplete_menu"></div>
        </div>
        <label style="margin-top:6px;">Syntax Highlight View:</label>
        <div class="highlight-helper" id="highlight_helper"></div>
      </div>

      <div class="form-group">
        <label>Background Image</label>
        <input type="text" class="input-text" id="node_prop_bg" value="${node.properties.background || ''}">
      </div>

      <div class="form-group">
        <label>Audio Loop Music</label>
        <input type="text" class="input-text" id="node_prop_audio_loop" value="${node.properties.audioLoop || ''}">
      </div>

      <div class="form-group">
        <label>Audio One-Shot Sound</label>
        <input type="text" class="input-text" id="node_prop_audio_shot" value="${node.properties.audioOneShot || ''}">
      </div>

      <div class="form-group" style="border-top:1px solid var(--border-color); padding-top:15px; margin-top:10px;">
        <label style="font-weight:600; color:var(--accent-info);">Awards & Collectibles</label>
      </div>

      <div class="form-group">
        <label>Add Item to Inventory</label>
        <select class="select-input" id="node_prop_reward_item">
          <option value="">None</option>
          ${this.globalVars.collectibles.map(item => `<option value="${item}" ${node.properties.rewardItems === item ? 'selected' : ''}>${item}</option>`).join('')}
        </select>
      </div>

      <div class="form-group">
        <label>Unlock Knowledge (Diary Page)</label>
        <select class="select-input" id="node_prop_reward_knowledge">
          <option value="">None</option>
          ${this.globalVars.knowledge.map(kw => `<option value="${kw}" ${node.properties.rewardKnowledge === kw ? 'selected' : ''}>${kw}</option>`).join('')}
        </select>
      </div>

      <div style="margin-top:20px; display:flex; gap:10px;">
        <button class="btn btn-primary" style="flex:1;" id="btn_save_inspector">Save Changes</button>
        <button class="btn btn-success" id="btn_llm_expand_node" title="Ask LLM to Expand dialogue content"><i class="fas fa-magic"></i> Expand Dialogue</button>
      </div>
    `;
    container.appendChild(form);

    this.setupAutocomplete("node_prop_text", "autocomplete_menu");
    this.setupDialogueHighlight("node_prop_text", "highlight_helper");
    this.setupQuickAddVariableListener("node_prop_characters", "quick_add_char_bubble", "characters");

    // Save Action
    document.getElementById("btn_save_inspector").onclick = () => {
      node.properties.title = document.getElementById("node_prop_title").value;
      node.properties.isChapterStart = document.getElementById("node_prop_chapter").checked;
      node.properties.location = document.getElementById("node_prop_location").value;
      node.properties.charactersPresent = document.getElementById("node_prop_characters").value;
      node.properties.text = document.getElementById("node_prop_text").value;
      node.properties.background = document.getElementById("node_prop_bg").value;
      node.properties.audioLoop = document.getElementById("node_prop_audio_loop").value;
      node.properties.audioOneShot = document.getElementById("node_prop_audio_shot").value;
      node.properties.rewardItems = document.getElementById("node_prop_reward_item").value;
      node.properties.rewardKnowledge = document.getElementById("node_prop_reward_knowledge").value;

      node.title = node.properties.title || "Dialogue";
      this.renderBookmarks();
      this.saveToLocalStorage();
      node.setDirtyCanvas(true, true);
      alert("Dialogue Node parameters updated!");
    };

    // LLM Expand Action
    document.getElementById("btn_llm_expand_node").onclick = () => {
      this.triggerLLMExpansion(node);
    };
  },

  // CHOICE DRAWER PANEL
  renderChoiceInspector(node, container) {
    const form = document.createElement("div");
    form.className = "inspector-scroll";
    form.style.padding = "0";
    form.innerHTML = `
      <div class="form-group">
        <label>Node Title</label>
        <input type="text" class="input-text" id="node_prop_title" value="${node.properties.title || ''}">
      </div>

      <div class="form-group">
        <label style="font-weight:600; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
          Choices branches
          <button class="btn btn-success" style="padding:2px 8px; font-size:11px;" id="btn_add_choice_item">+ Add Option</button>
        </label>
        <div id="choices_rows_container"></div>
      </div>

      <div style="margin-top:20px;">
        <button class="btn btn-primary" style="width:100%;" id="btn_save_choices">Save Choices Path</button>
      </div>
    `;
    container.appendChild(form);

    const rowsContainer = document.getElementById("choices_rows_container");

    // Pull current input values back into properties so re-rendering the
    // rows (add/delete) never discards unsaved edits in other rows
    const syncChoicesFromInputs = () => {
      const labelInputs = rowsContainer.querySelectorAll(".choice-label-val");
      const condInputs = rowsContainer.querySelectorAll(".choice-cond-val");
      labelInputs.forEach((inp, i) => {
        if (node.properties.choices[i]) {
          node.properties.choices[i].text = inp.value;
          node.properties.choices[i].condition = condInputs[i].value;
        }
      });
    };

    const renderChoicesRows = () => {
      rowsContainer.innerHTML = "";
      node.properties.choices.forEach((choice, idx) => {
        const row = document.createElement("div");
        row.className = "outcome-row";
        row.innerHTML = `
          <div class="outcome-row-header">
            <span style="font-size:12px; font-weight:600; color:var(--accent-secondary);">Branch Option #${idx + 1}</span>
            <button class="section-add-btn row-delete-btn" style="color:var(--accent-danger);">Delete</button>
          </div>
          <div class="form-group">
            <label>Button Label Text</label>
            <input type="text" class="input-text choice-label-val" data-idx="${idx}" value="${choice.text}" placeholder="Choice Description">
          </div>
          <div class="form-group">
            <label>Required Condition (Optional)</label>
            <input type="text" class="input-text choice-cond-val" data-idx="${idx}" value="${choice.condition || ''}" placeholder="e.g. has_item('rusty_key')">
          </div>
        `;
        row.querySelector(".row-delete-btn").onclick = () => {
          syncChoicesFromInputs();
          node.properties.choices.splice(idx, 1);
          renderChoicesRows();
        };
        rowsContainer.appendChild(row);
      });
    };

    renderChoicesRows();

    document.getElementById("btn_add_choice_item").onclick = () => {
      syncChoicesFromInputs();
      node.properties.choices.push({ text: "New Option", condition: "" });
      renderChoicesRows();
    };

    document.getElementById("btn_save_choices").onclick = () => {
      node.properties.title = document.getElementById("node_prop_title").value;
      
      const labelInputs = rowsContainer.querySelectorAll(".choice-label-val");
      const condInputs = rowsContainer.querySelectorAll(".choice-cond-val");
      
      node.properties.choices = [];
      labelInputs.forEach((inp, i) => {
        node.properties.choices.push({
          text: inp.value,
          condition: condInputs[i].value
        });
      });

      node.title = node.properties.title || "Path Selection";
      node.updateChoiceOutputs();
      this.saveToLocalStorage();
      node.setDirtyCanvas(true, true);
      alert("Choices Node saved!");
    };
  },

  // TRAVERSAL DRAWER PANEL
  renderTraversalInspector(node, container) {
    const form = document.createElement("div");
    form.className = "inspector-scroll";
    form.style.padding = "0";
    form.innerHTML = `
      <div class="form-group">
        <label>Node Title</label>
        <input type="text" class="input-text" id="node_prop_title" value="${node.properties.title || ''}">
      </div>

      <div class="form-group">
        <label>Escape Target Score Accumulation</label>
        <input type="number" class="input-text" id="node_prop_target" value="${node.properties.targetAccumulation || 100}">
      </div>

      <div class="form-group">
        <label style="font-weight:600; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
          Probability Events (Trigger on Roll)
          <button class="btn btn-success" style="padding:2px 8px; font-size:11px;" id="btn_add_outcome_item">+ Add Event</button>
        </label>
        <div id="outcomes_rows_container"></div>
      </div>

      <div style="margin-top:20px;">
        <button class="btn btn-primary" style="width:100%;" id="btn_save_traversal">Save Traversal</button>
      </div>
    `;
    container.appendChild(form);

    const rowsContainer = document.getElementById("outcomes_rows_container");

    const syncOutcomesFromInputs = () => {
      const labelInputs = rowsContainer.querySelectorAll(".outcome-label-val");
      const probInputs = rowsContainer.querySelectorAll(".outcome-prob-val");
      const descInputs = rowsContainer.querySelectorAll(".outcome-desc-val");
      labelInputs.forEach((inp, i) => {
        const out = node.properties.outcomes[i];
        if (!out) return;
        out.label = inp.value;
        out.probability = parseFloat(probInputs[i].value) || 0;
        out.description = descInputs[i].value || "";
      });
    };

    const renderOutcomes = () => {
      rowsContainer.innerHTML = "";
      node.properties.outcomes.forEach((out, idx) => {
        const row = document.createElement("div");
        row.className = "outcome-row";
        row.innerHTML = `
          <div class="outcome-row-header">
            <span style="font-size:12px; font-weight:600; color:var(--accent-warning);">Event Path #${idx + 1}</span>
            <button class="section-add-btn row-delete-btn" style="color:var(--accent-danger);">Delete</button>
          </div>
          <div class="form-group">
            <label>Event Name / Label</label>
            <input type="text" class="input-text outcome-label-val" data-idx="${idx}" value="${out.label || ''}" placeholder="e.g. Become Monster">
          </div>
          <div class="form-group">
            <label>Trigger Probability (0 - 100%)</label>
            <input type="number" class="input-text outcome-prob-val" data-idx="${idx}" value="${out.probability !== undefined ? out.probability : 10}" min="0" max="100" step="0.5">
          </div>
          <div class="form-group">
            <label>Message when triggered (Optional)</label>
            <input type="text" class="input-text outcome-desc-val" data-idx="${idx}" value="${out.description || ''}" placeholder="e.g. The corruption takes hold!">
          </div>
        `;
        row.querySelector(".row-delete-btn").onclick = () => {
          syncOutcomesFromInputs();
          node.properties.outcomes.splice(idx, 1);
          renderOutcomes();
        };
        rowsContainer.appendChild(row);
      });
    };

    renderOutcomes();

    document.getElementById("btn_add_outcome_item").onclick = () => {
      syncOutcomesFromInputs();
      node.properties.outcomes.push({ label: "Become Monster", probability: 10, description: "" });
      renderOutcomes();
    };

    document.getElementById("btn_save_traversal").onclick = () => {
      node.properties.title = document.getElementById("node_prop_title").value;
      node.properties.targetAccumulation = parseInt(document.getElementById("node_prop_target").value);
      
      const labelInputs = rowsContainer.querySelectorAll(".outcome-label-val");
      const probInputs = rowsContainer.querySelectorAll(".outcome-prob-val");
      const descInputs = rowsContainer.querySelectorAll(".outcome-desc-val");

      node.properties.outcomes = [];
      labelInputs.forEach((inp, i) => {
        node.properties.outcomes.push({
          label: inp.value,
          probability: parseFloat(probInputs[i].value) || 0,
          description: descInputs[i].value || ""
        });
      });

      node.title = node.properties.title || "Dice Maze Challenge";
      node.updateOutputs();
      this.saveToLocalStorage();
      node.setDirtyCanvas(true, true);
      alert("Traversal Node saved successfully!");
    };
  },

  // LOGIC GATE DRAWER PANEL
  renderLogicGateInspector(node, container) {
    const form = document.createElement("div");
    form.className = "inspector-scroll";
    form.style.padding = "0";
    form.innerHTML = `
      <div class="form-group">
        <label>Node Title</label>
        <input type="text" class="input-text" id="node_prop_title" value="${node.properties.title || ''}">
      </div>

      <div class="form-group">
        <label>Condition Expression</label>
        <input type="text" class="input-text" id="node_prop_condition" value="${node.properties.condition || ''}" placeholder="e.g. has_knowledge('heard_rustle')">
        <span style="font-size:11px; color:var(--text-dark); margin-top:2px;">
          Available commands: <br>
          - <code>has_item('item_id')</code><br>
          - <code>has_knowledge('flag_name')</code>
        </span>
      </div>

      <div style="margin-top:20px;">
        <button class="btn btn-primary" style="width:100%;" id="btn_save_logic_gate">Save Logic Gate</button>
      </div>
    `;
    container.appendChild(form);

    document.getElementById("btn_save_logic_gate").onclick = () => {
      node.properties.title = document.getElementById("node_prop_title").value;
      node.properties.condition = document.getElementById("node_prop_condition").value;
      node.title = node.properties.title || "Conditional Gate";
      this.saveToLocalStorage();
      node.setDirtyCanvas(true, true);
      alert("Logic Gate saved!");
    };
  },

  // 4. RICH DIALOGUE EDITOR AUTOCOMPLETE & HIGHLIGHT
  setupAutocomplete(textareaId, menuId) {
    const textarea = document.getElementById(textareaId);
    const menu = document.getElementById(menuId);
    if (!textarea || !menu) return;

    let showMenu = false;
    let queryStart = -1;

    textarea.addEventListener("input", (e) => {
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
      if (showMenu) {
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
          if (activeItem) {
            activeItem.click();
          } else if (items.length > 0) {
            items[0].click();
          }
        } else if (e.key === "Escape") {
          showMenu = false;
          menu.style.display = "none";
        }
      }
    });
  },

  showSuggestions(query, menu, textarea, queryStart) {
    // Collect possible autocomplete variables
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
        <span>{${item.name}}</span>
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
        
        // Trigger synthetic input to update highlights helper
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
      let rawText = textarea.value;
      
      // Escape HTML
      let html = rawText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      // Replace {Char} -> tag-highlight char
      this.globalVars.characters.forEach(char => {
        const regex = new RegExp(`{${char}}`, 'g');
        html = html.replace(regex, `<span class="tag-highlight char">${char}</span>`);
      });

      // Replace {Loc} -> tag-highlight loc
      this.globalVars.locations.forEach(loc => {
        const regex = new RegExp(`{${loc}}`, 'g');
        html = html.replace(regex, `<span class="tag-highlight loc">${loc}</span>`);
      });

      helper.innerHTML = html;
    };

    textarea.addEventListener("input", updateHighlight);
    updateHighlight();
  },

  setupQuickAddVariableListener(inputId, bubbleId, category) {
    const input = document.getElementById(inputId);
    const bubble = document.getElementById(bubbleId);
    if (!input || !bubble) return;

    input.addEventListener("input", () => {
      const items = input.value.split(',').map(s => s.trim()).filter(Boolean);
      if (items.length === 0) {
        bubble.style.display = "none";
        return;
      }
      
      const newItems = items.filter(item => !this.globalVars[category].includes(item));
      
      if (newItems.length > 0) {
        const nextItem = newItems[0];
        bubble.style.display = "flex";
        bubble.innerHTML = `
          <span>Add <strong>"${nextItem}"</strong> to globals?</span>
          <button class="btn btn-success" style="padding:2px 8px; font-size:11px;" onclick="VNovelApp.quickAddAndClearBubble('${category}', '${nextItem}', '${bubbleId}')">Add</button>
        `;
      } else {
        bubble.style.display = "none";
      }
    });
  },

  quickAddAndClearBubble(category, name, bubbleId) {
    this.addVariable(category, name);
    document.getElementById(bubbleId).style.display = "none";
    alert(`Added ${name} to global ${category}!`);
  },

  updateInspectorAutocompletes() {
    if (this.activeNode && this.activeNode.type === "vnovel/passthrough") {
      this.setupDialogueHighlight("node_prop_text", "highlight_helper");
    }
  },

  // 5. PLAYBACK ENGINE PLAYER RUNTIME
  startPlayback(customStartNode = null) {
    const startNode = customStartNode || this.findStartNode();
    if (!startNode) {
      alert("No entry point path found! Connect a Passthrough Node to begin writing narratives.");
      return;
    }

    // Reset Player states
    this.gameState.inventory = new Set();
    this.gameState.diaryKnowledge = new Set();
    this.gameState.traversalScores = {};
    this.gameState.currentLogHistory = [];
    this.gameState.isPlaying = true;
    
    // Hide editor layout, show Playback overlay
    document.getElementById("playback_overlay").style.display = "flex";
    this.closeInspector();
    
    this.renderDiaryPanel();
    this.navigateToNode(startNode);
  },

  stopPlayback() {
    this.gameState.isPlaying = false;
    document.getElementById("playback_overlay").style.display = "none";
    this.audioState.currentLoop = null;
    
    // Refresh bookmarks in editor
    this.renderBookmarks();
  },

  findStartNode() {
    // 1. Check if a node is currently selected
    if (this.canvas && this.canvas.selected_nodes) {
      const selectedIds = Object.keys(this.canvas.selected_nodes);
      if (selectedIds.length > 0) {
        const selNode = this.canvas.selected_nodes[selectedIds[0]];
        if (selNode && ["vnovel/passthrough", "vnovel/choice", "vnovel/traversal", "vnovel/logic_gate"].includes(selNode.type)) {
          return selNode;
        }
      }
    }

    const nodes = this.graph._nodes || [];
    // 2. If bookmarks exist, pick the first bookmarked Chapter start
    const bookmarkedNode = nodes.find(n => n.properties && n.properties.isChapterStart);
    if (bookmarkedNode) return bookmarkedNode;

    // 3. Pick the Passthrough node with no inputs connected
    const entryNode = nodes.find(n => {
      return n.type === "vnovel/passthrough" && (!n.inputs[0].link);
    });
    if (entryNode) return entryNode;

    // 4. Just pick the first available Passthrough node
    return nodes.find(n => n.type === "vnovel/passthrough");
  },

  navigateToNode(node) {
    if (!node) {
      this.showEnding("The narrative reaches a quiet end. Thanks for playing!");
      return;
    }

    this.gameState.currentChunkId = node.id;
    
    // Handle specific node types
    if (node.type === "vnovel/passthrough") {
      this.playPassthroughNode(node);
    } else if (node.type === "vnovel/choice") {
      this.playChoiceNode(node);
    } else if (node.type === "vnovel/traversal") {
      this.playTraversalNode(node);
    } else if (node.type === "vnovel/logic_gate") {
      this.evaluateLogicGateNode(node);
    }
  },

  // A. PLAY PASSTHROUGH
  playPassthroughNode(node) {
    const viewer = document.getElementById("playback_overlay");
    const container = document.getElementById("playback_interactive_area");
    
    // Apply background image if defined
    if (node.properties.background) {
      // Mock images fallback to nice stylized gradients to prevent empty links
      if (node.properties.background.includes(".png") || node.properties.background.includes(".jpg")) {
        viewer.style.backgroundImage = `url('https://images.unsplash.com/photo-1518837695005-2083093ee35b?q=80&w=1200')`; // Forest Mock
      } else {
        viewer.style.backgroundImage = node.properties.background;
      }
    } else {
      viewer.style.backgroundImage = "linear-gradient(135deg, #1e1b4b, #0f172a)";
    }

    // Audio controller simulator logger
    if (node.properties.audioLoop && this.audioState.currentLoop !== node.properties.audioLoop) {
      this.logAudioCrossfade(this.audioState.currentLoop, node.properties.audioLoop);
      this.audioState.currentLoop = node.properties.audioLoop;
    }
    if (node.properties.audioOneShot) {
      console.log(`[Audio SFX] Playing OneShot: ${node.properties.audioOneShot}`);
    }

    // Apply collectibles and diary rewards
    if (node.properties.rewardItems) {
      this.gameState.inventory.add(node.properties.rewardItems);
      this.triggerHUDNotification(`Acquired: ${node.properties.rewardItems}`);
    }
    if (node.properties.rewardKnowledge) {
      if (!this.gameState.diaryKnowledge.has(node.properties.rewardKnowledge)) {
        this.gameState.diaryKnowledge.add(node.properties.rewardKnowledge);
        this.pushDiaryEntry(`Discovered: "${node.properties.rewardKnowledge}" - A clue was cataloged in your journals.`);
        this.triggerHUDNotification(`Diary Updated!`);
      }
    }

    // Queue up the node text as sequential dialogue beats (one per line)
    const textPayload = node.properties.text || "...";
    this.dialogueQueue = textPayload.split("\n").map(l => l.trim()).filter(Boolean);
    if (this.dialogueQueue.length === 0) this.dialogueQueue = ["..."];
    this.dialogueQueueIndex = 0;

    this.renderCurrentDialogueLine(node);
    this.updateHUD();
  },

  renderCurrentDialogueLine(node) {
    const container = document.getElementById("playback_interactive_area");
    container.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.className = "dialogue-gui-wrapper";

    const line = this.dialogueQueue[this.dialogueQueueIndex];
    const parsedLine = this.parseSpeakerLine(line);
    const isLastLine = this.dialogueQueueIndex >= this.dialogueQueue.length - 1;

    wrapper.innerHTML = `
      <div class="dialogue-gui-box" onclick="VNovelApp.proceedFromPassthrough(${node.id})">
        ${parsedLine.speaker ? `<div class="dialogue-speaker" style="color:${parsedLine.speakerColor}; border-bottom:2px solid ${parsedLine.speakerColor};">${parsedLine.speaker}</div>` : ''}
        <div class="dialogue-text">${parsedLine.text}</div>
        <div class="dialogue-next-prompt">${isLastLine ? 'Click dialogue card to continue' : `Click for next line (${this.dialogueQueueIndex + 1}/${this.dialogueQueue.length})`} <i class="fas fa-chevron-right"></i></div>
      </div>
    `;
    container.appendChild(wrapper);
  },

  proceedFromPassthrough(nodeId) {
    const node = this.graph.getNodeById(nodeId);
    if (!node) return;

    // More dialogue lines left inside this node? Advance the beat first.
    if (this.dialogueQueue && this.dialogueQueueIndex < this.dialogueQueue.length - 1) {
      this.dialogueQueueIndex++;
      this.renderCurrentDialogueLine(node);
      return;
    }

    // Follow Out link
    this.navigateToNode(this.getOutputTargetNode(node, 0));
  },

  // B. PLAY CHOICE BRANCHING
  playChoiceNode(node) {
    const container = document.getElementById("playback_interactive_area");
    container.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.className = "dialogue-gui-wrapper";
    
    const title = node.properties.title || "What will you do next?";
    let html = `
      <div class="dialogue-gui-box" style="min-height:auto; pointer-events:none; margin-bottom:10px;">
        <div class="dialogue-speaker" style="color:var(--accent-secondary); border-bottom:2px solid var(--accent-secondary);">Narrator</div>
        <div class="dialogue-text">${title}</div>
      </div>
      <div class="playback-choices-container">
    `;

    node.properties.choices.forEach((choice, index) => {
      const allowed = this.evaluateCondition(choice.condition);
      if (allowed) {
        html += `<button class="choice-button" onclick="VNovelApp.selectChoiceBranch(${node.id}, ${index})">${choice.text}</button>`;
      } else {
        html += `<button class="choice-button disabled" disabled>${choice.text} (Requires: ${choice.condition})</button>`;
      }
    });

    html += `</div>`;
    wrapper.innerHTML = html;
    container.appendChild(wrapper);
    this.updateHUD();
  },

  selectChoiceBranch(nodeId, choiceIdx) {
    const node = this.graph.getNodeById(nodeId);
    if (!node) return;

    this.navigateToNode(this.getOutputTargetNode(node, choiceIdx));
  },

  // C. PLAY TRAVERSAL DICE CHALLENGE
  playTraversalNode(node) {
    const container = document.getElementById("playback_interactive_area");
    container.innerHTML = "";

    const scoreKey = `node_${node.id}`;
    if (this.gameState.traversalScores[scoreKey] === undefined) {
      this.gameState.traversalScores[scoreKey] = 0;
    }

    const currentScore = this.gameState.traversalScores[scoreKey];
    const target = node.properties.targetAccumulation || 100;

    // Build outcomes list HTML
    let outcomesHtml = "";
    if (node.properties.outcomes && node.properties.outcomes.length > 0) {
      outcomesHtml = `
        <div style="margin-top:12px; padding:10px; background:rgba(0,0,0,0.2); border-radius:6px; font-size:11px; text-align:left; color:var(--text-muted);">
          <div style="font-weight:600; color:var(--accent-warning); margin-bottom:4px; text-transform:uppercase; font-size:10px;">Dangerous Risk Events:</div>
          ${node.properties.outcomes.map(out => `
            <div style="display:flex; justify-content:space-between; margin-bottom:2px;">
              <span>• ${out.label}</span>
              <span style="color:var(--accent-danger); font-weight:500;">${out.probability}% chance</span>
            </div>
          `).join('')}
        </div>
      `;
    }

    const mainDiv = document.createElement("div");
    mainDiv.className = "dice-roll-container";
    mainDiv.innerHTML = `
      <div class="dice-title">${node.properties.title || 'Maze Room Roll'}</div>
      <div class="dice-stats">
        <div>Progress Score: <span class="dice-stat-val" id="dice_progress_val">${currentScore}</span> / ${target}</div>
      </div>
      <div class="dice-cube" id="dice_visual_cube">?</div>
      <button class="btn btn-primary btn-success" style="width:100%; border-radius:30px; font-weight:600;" id="btn_roll_dice_act">Roll d20 Dice</button>
      <div style="font-size:12px; color:var(--text-muted); margin-top:5px;" id="dice_roll_desc">Each roll adds points towards escaping. Watch out for dangerous events!</div>
      ${outcomesHtml}
    `;

    container.appendChild(mainDiv);

    document.getElementById("btn_roll_dice_act").onclick = () => {
      this.triggerDiceRoll(node, scoreKey);
    };
    this.updateHUD();
  },

  triggerDiceRoll(node, scoreKey) {
    const cube = document.getElementById("dice_visual_cube");
    const btn = document.getElementById("btn_roll_dice_act");
    const desc = document.getElementById("dice_roll_desc");
    
    if (btn.disabled) return;
    
    btn.disabled = true;
    cube.classList.add("rolling");
    cube.innerHTML = "...";
    
    setTimeout(() => {
      cube.classList.remove("rolling");
      const roll = Math.floor(Math.random() * 20) + 1;
      cube.innerHTML = roll;

      // Check if any of the special probability-based outcomes trigger
      let triggeredOutcome = null;
      if (node.properties.outcomes && node.properties.outcomes.length > 0) {
        for (let out of node.properties.outcomes) {
          const chance = out.probability !== undefined ? out.probability : 10;
          if (Math.random() * 100 < chance) {
            triggeredOutcome = out;
            break; // Trigger the first one that hits
          }
        }
      }

      if (triggeredOutcome) {
        desc.innerHTML = `<span style="color:var(--accent-danger); font-weight:600;">Triggered Event: ${triggeredOutcome.label}!</span> ${triggeredOutcome.description || ''}`;
        
        setTimeout(() => {
          const outcomeIdx = node.properties.outcomes.indexOf(triggeredOutcome);
          const targetNode = this.getOutputTargetNode(node, outcomeIdx + 1);
          if (targetNode) {
            this.navigateToNode(targetNode);
          } else {
            // If nothing connected, reset/restart the room as fallback
            alert(`Event triggered: ${triggeredOutcome.label}. No output path is connected to this slot!`);
            this.gameState.traversalScores[scoreKey] = 0;
            this.playTraversalNode(node);
          }
        }, 2000);
        return;
      }

      // No special event triggered -> Add to accumulation score
      this.gameState.traversalScores[scoreKey] += roll;
      const newScore = this.gameState.traversalScores[scoreKey];
      document.getElementById("dice_progress_val").innerHTML = newScore;
      
      const targetTarget = node.properties.targetAccumulation || 100;
      desc.innerHTML = `Rolled a ${roll}. Progress added! (+${roll} points)`;

      this.updateHUD();

      setTimeout(() => {
        if (newScore >= targetTarget) {
          desc.innerHTML = `<span style="color:var(--accent-success); font-weight:600;">Success! Reached the target of ${targetTarget}!</span>`;
          setTimeout(() => {
            // Out 0 represents the Escape slot!
            this.navigateToNode(this.getOutputTargetNode(node, 0));
          }, 1500);
        } else {
          // Keep rolling
          btn.disabled = false;
          desc.innerHTML += ` (Keep rolling to reach ${targetTarget}!)`;
        }
      }, 1200);

    }, 800);
  },

  // D. LOGIC GATE AUTOMATIC BRANCHE EVALUATION
  evaluateLogicGateNode(node) {
    const cond = node.properties.condition;
    const isTrue = this.evaluateCondition(cond);
    
    console.log(`[Logic Gate Evaluator] "${cond}" evaluated to: ${isTrue}`);

    const slotIdx = isTrue ? 0 : 1; // Out 0 is True path, Out 1 is False path
    this.navigateToNode(this.getOutputTargetNode(node, slotIdx));
  },

  // E. GENERAL PLAYBACK HELPERS
  getTargetNodeFromLink(linkId) {
    const linkInfo = this.graph.links[linkId];
    if (!linkInfo) return null;
    return this.graph.getNodeById(linkInfo.target_id);
  },

  // LiteGraph output slots store connections in a "links" ARRAY (inputs use
  // the singular "link"). Follow the first connection out of a given slot.
  getOutputTargetNode(node, slotIdx) {
    const output = node.outputs && node.outputs[slotIdx];
    if (!output || !output.links || output.links.length === 0) return null;
    return this.getTargetNodeFromLink(output.links[0]);
  },

  parseSpeakerLine(line) {
    // Regex looking for {Char}: dialog
    const match = line.match(/^{([^}]+)}:\s*(.*)/s);
    if (match) {
      const speaker = match[1];
      const speech = match[2];
      
      // Select custom color for key characters
      let color = "var(--accent-primary)";
      if (speaker.toLowerCase() === "wizard") color = "var(--accent-secondary)";
      if (speaker.toLowerCase() === "goblin") color = "var(--accent-warning)";
      if (speaker.toLowerCase() === "narrator") color = "var(--text-muted)";

      return { speaker, text: speech, speakerColor: color };
    }
    return { speaker: null, text: line, speakerColor: "#fff" };
  },

  evaluateCondition(conditionStr) {
    if (!conditionStr || !conditionStr.trim()) return true;

    try {
      // Safe sandbox regex parsing for:
      // has_item('item_name')
      // has_knowledge('knowledge_name')
      
      let res = true;
      
      const itemMatch = conditionStr.match(/has_item\(['"](.+?)['"]\)/);
      if (itemMatch) {
        const reqItem = itemMatch[1];
        res = res && this.gameState.inventory.has(reqItem);
      }

      const kwMatch = conditionStr.match(/has_knowledge\(['"](.+?)['"]\)/);
      if (kwMatch) {
        const reqKw = kwMatch[1];
        res = res && this.gameState.diaryKnowledge.has(reqKw);
      }

      return res;
    } catch(err) {
      console.error("Condition parsing failed for expression: " + conditionStr, err);
      return false;
    }
  },

  showEnding(message) {
    const container = document.getElementById("playback_interactive_area");
    container.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.className = "dialogue-gui-wrapper";
    wrapper.innerHTML = `
      <div class="dialogue-gui-box" style="text-align:center;">
        <div class="dialogue-speaker" style="color:var(--accent-success); border-bottom:2px solid var(--accent-success);">Chapter Completed</div>
        <div class="dialogue-text">${message}</div>
        <button class="btn btn-primary" style="margin-top:15px; margin-left:auto; margin-right:auto; display:block;" onclick="VNovelApp.stopPlayback()">Return to Editor</button>
      </div>
    `;
    container.appendChild(wrapper);
  },

  // 6. HUD & DIARY PANEL MANAGEMENT IN PLAYBACK OVERLAY
  updateHUD() {
    const invEl = document.getElementById("playback_hud_inventory");
    if (!invEl) return;
    
    if (this.gameState.inventory.size === 0) {
      invEl.innerHTML = `<span style="color:var(--text-dark);">Empty</span>`;
    } else {
      invEl.innerHTML = Array.from(this.gameState.inventory).map(item => `
        <span class="variable-tag collectible">${item}</span>
      `).join('');
    }
  },

  triggerHUDNotification(message) {
    const banner = document.createElement("div");
    banner.style.position = "absolute";
    banner.style.top = "75px";
    banner.style.left = "50%";
    banner.style.transform = "translateX(-50%)";
    banner.style.background = "rgba(16, 185, 129, 0.9)";
    banner.style.color = "#fff";
    banner.style.padding = "8px 16px";
    banner.style.borderRadius = "20px";
    banner.style.fontSize = "12px";
    banner.style.fontWeight = "600";
    banner.style.zIndex = "100";
    banner.style.boxShadow = "0 4px 15px rgba(0,0,0,0.3)";
    banner.innerHTML = `<i class="fas fa-check-circle"></i> ${message}`;
    
    document.getElementById("playback_overlay").appendChild(banner);
    setTimeout(() => banner.remove(), 2500);
  },

  toggleDiaryPanel() {
    const el = document.getElementById("playback_diary_drawer");
    el.classList.toggle("open");
    this.renderDiaryPanel();
  },

  renderDiaryPanel() {
    const list = document.getElementById("playback_diary_list");
    if (!list) return;
    list.innerHTML = "";

    if (this.gameState.diaryKnowledge.size === 0) {
      list.innerHTML = `<div style="font-size:12px; color:var(--text-dark); font-style:italic; padding:10px;">No entries logged in diary yet. Discover more locations or encounter events.</div>`;
      return;
    }

    this.gameState.currentLogHistory.forEach(entry => {
      const el = document.createElement("div");
      el.className = "diary-entry";
      el.innerText = entry;
      list.appendChild(el);
    });
  },

  pushDiaryEntry(str) {
    this.gameState.currentLogHistory.push(str);
    this.renderDiaryPanel();
  },

  logAudioCrossfade(oldAudio, newAudio) {
    console.log(`[Audio Crossfade Simulation] Fading out loops: ${oldAudio || 'none'} -> Fading in loop: ${newAudio}`);
    // Simulate updating HUD visualizer state
    const hud = document.getElementById("playback_audio_visual");
    if (hud) {
      hud.innerHTML = `
        <span class="audio-bar anim"></span>
        <span class="audio-bar anim"></span>
        <span class="audio-bar anim"></span>
      `;
    }
  },

  // 7. LLM COPILOT API CORE & MOCKS
  openLLMModal() {
    document.getElementById("llm_modal_overlay").style.display = "flex";
  },

  closeLLMModal() {
    document.getElementById("llm_modal_overlay").style.display = "none";
  },

  async runScreenplayImporter() {
    const text = document.getElementById("llm_screenplay_input").value;
    const logs = document.getElementById("llm_console_logs");
    
    if (!text || !text.trim()) {
      alert("Please paste screenplay script content first.");
      return;
    }

    logs.innerHTML = `<div class="log-message warning">Processing screenplay... Running script-to-JSON compiler.</div>`;

    const apiKey = document.getElementById("llm_api_key_input").value.trim();
    
    if (apiKey) {
      // Direct integration call using API
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
      // Simulated screenplay text splits compiler
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
            background: "mysterious_woods.jpg",
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
        // Look for scene headers
        if (line.startsWith("INT.") || line.startsWith("EXT.")) {
          flushNode();
          activeLocation = line.replace(/^(INT\.|EXT\.)/, "").trim();
          this.addVariable("locations", activeLocation);
        } else if (line.match(/^[A-Z\s]+$/)) {
          // Character name block (Screenplay formatting)
          const char = line.trim();
          activeCharacters.add(char);
          this.addVariable("characters", char);
          nodeDialogueAccumulator.push(`{${char}}`);
        } else {
          // Dialog lines
          if (nodeDialogueAccumulator.length > 0) {
            // Append dialogue next to character
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

      // Insert generated nodes into the existing graph at the current view
      const created = this.insertNarrativeNodes(nodes);
      logs.innerHTML = `<div class="log-message success"><strong>Simulation Success!</strong> Inserted ${created.length} new narrative nodes at your current canvas view — existing nodes untouched. The batch is selected, so you can drag it into place, then wire it to your story.</div>`;
    } catch(err) {
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
        alert("Dialogue expanded via live LLM!");
      } catch (err) {
        alert("API error: " + err.message + ". Fallback simulation triggered.");
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
      const match = line.match(/^{(\w+)}:\s*(.*)/s);
      if (match) {
        const char = match[1];
        const speech = match[2];
        expandedLines.push(`{${char}}: *takes a deep breath, looking around the rustling woods* "${speech} It feels like we aren't alone here..."`);
      } else {
        expandedLines.push(line + " *The shadows align closer in the dark.*");
      }
    });

    node.properties.text = expandedLines.join("\n");
    this.openInspector(node);
    alert("Narrative expanded successfully (Simulated creative expansion mode)!");
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
        // Check for unconnected output slots
        if (node.outputs && node.outputs.length > 0) {
          let hasConnection = false;
          node.outputs.forEach(out => {
            if (out.links && out.links.length > 0) hasConnection = true;
          });

          // End nodes can be disconnected
          if (!hasConnection && node.type !== "vnovel/choice" && node.type !== "vnovel/traversal") {
            issues.push({
              level: 'warning',
              msg: `Orphan Node #${node.id} (${node.title}): Output terminal is unconnected. Playback will stop abruptly.`
            });
          }
        }

        // Check logic expressions variables
        if (node.type === "vnovel/logic_gate") {
          const cond = node.properties.condition;
          const matchItem = cond.match(/has_item\(['"](.+?)['"]\)/);
          if (matchItem) {
            const reqItem = matchItem[1];
            // Check if any node rewards this item
            let itemFound = false;
            nodes.forEach(n => {
              if (n.properties && n.properties.rewardItems === reqItem) itemFound = true;
            });
            if (!itemFound) {
              issues.push({
                level: 'danger',
                msg: `Unresolvable condition in Logic Node #${node.id}: Checking for inventory item "${reqItem}" which is never awarded by any dialogue node.`
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
                msg: `Dead lock warning in Logic Node #${node.id}: Diary flag "${reqKw}" is checked but never granted by nodes.`
              });
            }
          }
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

  async callLLMApi(key, action, content) {
    let prompt = "";
    if (action === "screenplay") {
      prompt = `You are a visual novel game engine script compiler. Convert the following screenplay into a valid JSON object matching our node graph structure.
Return ONLY the raw JSON object — no markdown fences, no commentary, no "chapters" wrapper. The top-level key must be "nodes". Every line of dialogue from the screenplay must appear in some node's "text" field. Chain sequential nodes with "next".
Format the output strictly as a JSON object matching this structure:
{
  "nodes": {
    "node_1": {
      "type": "passthrough",
      "location": "Dark Forest",
      "charactersPresent": ["Hero"],
      "text": "{Hero}: Hello there",
      "background": "forest.png",
      "next": "node_2"
    }
  }
}
Screenplay text:
${content}`;
    } else {
      prompt = `Flesh out this visual novel dialogue to make it engaging and descriptive. Keep the character tokens intact like {Hero}:
${content}`;
    }

    const provider = this.getSelectedProvider();
    const resultText = provider === "anthropic"
      ? await this.callAnthropicApi(key, prompt)
      : await this.callGeminiApi(key, prompt);

    if (action === "screenplay") {
      // Find JSON block
      const jsonMatch = resultText.match(/{[\s\S]*}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error("Could not parse JSON block from API response.");
    }

    return resultText;
  },

  async callAnthropicApi(key, prompt) {
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
        model: 'claude-opus-4-8',
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
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
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
    const nodes = this.extractNarrativeNodes(parsed);
    return this.insertNarrativeNodes(nodes);
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

    // Drop the batch at the center of what the user is currently looking at
    const ds = this.canvas.ds;
    const originX = (this.canvas.canvas.width / 2) / ds.scale - ds.offset[0] - 300;
    const originY = (this.canvas.canvas.height / 2) / ds.scale - ds.offset[1] - 100;

    const createdNodes = {};
    const createdList = [];
    let xOffset = originX;
    let yOffset = originY;
    let col = 0;

    // First pass: create all LiteGraph node instances (IDs are assigned by
    // the graph — never forced from key names, which can collide with
    // existing nodes and corrupt links)
    keys.forEach(nodeKey => {
      const data = narrativeNodes[nodeKey] || {};
      let lgNode = null;

      if (data.type === "choice") {
        lgNode = LiteGraph.createNode("vnovel/choice");
        lgNode.properties.choices = (data.choices || []).map(c => ({
          text: c.text || "Option",
          condition: c.condition || ""
        }));
        lgNode.updateChoiceOutputs();
      } else {
        // Treat passthrough AND any unrecognized type as dialogue so no
        // imported content is silently dropped
        lgNode = LiteGraph.createNode("vnovel/passthrough");
        lgNode.properties.location = data.location || "Unknown";
        lgNode.properties.charactersPresent = Array.isArray(data.charactersPresent)
          ? data.charactersPresent.join(", ")
          : (data.charactersPresent || "");
        lgNode.properties.text = data.text || "";
        lgNode.properties.background = data.background || "";
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
        yOffset += 200;
      }
    });

    // Second pass: wire connections between the newly created nodes
    keys.forEach(nodeKey => {
      const data = narrativeNodes[nodeKey] || {};
      const sourceNode = createdNodes[nodeKey];
      if (!sourceNode) return;

      if (data.type === "choice" && data.choices) {
        data.choices.forEach((choice, choiceIdx) => {
          const targetNode = choice.target && createdNodes[choice.target];
          if (targetNode) sourceNode.connect(choiceIdx, targetNode, 0);
        });
      } else if (data.next) {
        const targetNode = createdNodes[data.next];
        if (targetNode) sourceNode.connect(0, targetNode, 0);
      }
    });

    // Select the batch so it can be dragged as a group, and bring it into view
    if (this.canvas.selectNodes) {
      this.canvas.selectNodes(createdList);
    }
    if (createdList.length > 0) {
      this.canvas.centerOnNode(createdList[0]);
    }

    this.renderBookmarks();
    this.saveToLocalStorage();
    this.canvas.draw(true, true);
    return createdList;
  },

  // 8. PROJECT IMPORT / EXPORT & DEMO PROJECT LOADING
  exportProject() {
    const state = {
      graphSchema: this.graph.serialize(),
      globalVars: this.globalVars
    };

    const str = JSON.stringify(state, null, 2);
    navigator.clipboard.writeText(str).then(() => {
      alert("Project Schema copied to clipboard successfully! Use this block to share or import your projects.");
    }).catch(err => {
      alert("Failed to auto copy: " + err.message + "\nHere is the raw schema: \n\n" + str);
    });
  },

  importProject() {
    const schema = prompt("Paste your narrative project JSON state block here:");
    if (!schema) return;

    try {
      const state = JSON.parse(schema);
      if (state.graphSchema) this.graph.configure(state.graphSchema);
      if (state.globalVars) this.globalVars = state.globalVars;

      this.renderGlobalTags();
      this.renderBookmarks();
      this.canvas.draw(true, true);
      this.saveToLocalStorage();
      alert("Narrative graph project loaded successfully!");
    } catch (err) {
      alert("Failed to parse project JSON: " + err.message);
    }
  },

  saveToLocalStorage() {
    const state = {
      graphSchema: this.graph.serialize(),
      globalVars: this.globalVars
    };
    localStorage.setItem("vnovel_active_save_v2", JSON.stringify(state));
  },

  loadFromLocalStorage() {
    const saved = localStorage.getItem("vnovel_active_save_v2");
    if (saved) {
      try {
        const state = JSON.parse(saved);
        if (state.graphSchema) this.graph.configure(state.graphSchema);
        if (state.globalVars) this.globalVars = state.globalVars;
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

  // PRE-CONFIGURED DEMO
  loadDemoProject() {
    if (this.loadFromLocalStorage()) return;

    // Re-create a beautiful forest scene
    this.graph.clear();
    
    // Node 1: Intro Passthrough
    const n1 = LiteGraph.createNode("vnovel/passthrough");
    n1.id = 101;
    n1.properties.title = "Act I: Whispers in the Woods";
    n1.properties.location = "Dark Forest";
    n1.properties.charactersPresent = "Hero, Goblin";
    n1.properties.text = "{Hero}: Did you hear that?\n{Goblin}: *cringes in the shadow* Run! Run before they notice us!";
    n1.properties.rewardKnowledge = "heard_rustle";
    n1.properties.isChapterStart = true;
    n1.properties.background = "forest_night.png";
    n1.pos = [80, 150];
    this.graph.add(n1);

    // Node 2: Choices Branch
    const n2 = LiteGraph.createNode("vnovel/choice");
    n2.id = 102;
    n2.properties.title = "Fateful Encounter";
    n2.properties.choices = [
      { text: "Fight the Goblin companion", condition: "" },
      { text: "Examine the mysterious locked gate", condition: "has_knowledge('heard_rustle')" }
    ];
    n2.updateChoiceOutputs();
    n2.pos = [380, 150];
    this.graph.add(n2);

    // Node 3: Combat (Passthrough Node)
    const n3 = LiteGraph.createNode("vnovel/passthrough");
    n3.id = 103;
    n3.properties.title = "Sudden Skirmish";
    n3.properties.location = "Dark Forest";
    n3.properties.charactersPresent = "Goblin";
    n3.properties.text = "{Goblin}: Why do you draw your sword? Help! *The fight starts*";
    n3.properties.rewardItems = "ancient_coin";
    n3.pos = [680, 50];
    this.graph.add(n3);

    // Node 4: The gate (Passthrough Node awarding Key)
    const n4 = LiteGraph.createNode("vnovel/passthrough");
    n4.id = 104;
    n4.properties.title = "Undergrowth Gate";
    n4.properties.location = "Dark Forest";
    n4.properties.charactersPresent = "Hero";
    n4.properties.text = "{Narrator}: A mossy iron gate blocks the pass. Buried in the root, you spot a rusty iron key.\n{Hero}: Let's grab this.";
    n4.properties.rewardItems = "rusty_key";
    n4.pos = [680, 250];
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
    n5.pos = [980, 250];
    this.graph.add(n5);

    // Node 6: Escape End Node
    const n6 = LiteGraph.createNode("vnovel/passthrough");
    n6.id = 106;
    n6.properties.title = "Glade of Lights";
    n6.properties.location = "Secret Cave";
    n6.properties.charactersPresent = "Wizard";
    n6.properties.text = "{Wizard}: Ah, travelers, you managed to bypass the traps! Welcome to the sacred ruins.";
    n6.pos = [1300, 250];
    this.graph.add(n6);

    // Node 7: Mutation End Node
    const n7 = LiteGraph.createNode("vnovel/passthrough");
    n7.id = 107;
    n7.properties.title = "Mutated Ending";
    n7.properties.location = "Secret Cave";
    n7.properties.charactersPresent = "Hero";
    n7.properties.text = "{Hero}: Argh! The dark corruption... it's taking over! I've become a monster of the forest...";
    n7.pos = [1300, 450];
    this.graph.add(n7);

    // Node 8: Death End Node
    const n8 = LiteGraph.createNode("vnovel/passthrough");
    n8.id = 108;
    n8.properties.title = "Death Ending";
    n8.properties.location = "Forgotten Maze Loop";
    n8.properties.charactersPresent = "Narrator";
    n8.properties.text = "{Narrator}: The spikes pierced deep. Your journey ends here in the dark.";
    n8.pos = [1300, 50];
    this.graph.add(n8);

    // Connections
    n1.connect(0, n2, 0); // Intro -> Choice
    n2.connect(0, n3, 0); // Option 1 -> Combat
    n2.connect(1, n4, 0); // Option 2 -> Gate
    n4.connect(0, n5, 0); // Gate -> Maze
    n5.connect(0, n6, 0); // Maze Success (Escaped Out 0) -> Exit Node
    n5.connect(1, n7, 0); // Become Monster -> Mutation Ending
    n5.connect(2, n8, 0); // Spike Trap -> Death Ending

    this.renderGlobalTags();
    this.renderBookmarks();
    this.canvas.draw(true, true);
  },

  registerEventHandlers() {
    // LLM Modal Button Triggers
    document.getElementById("btn_open_llm_copilot").onclick = () => this.openLLMModal();
    document.getElementById("btn_close_llm_modal").onclick = () => this.closeLLMModal();
    document.getElementById("btn_llm_run_screenplay").onclick = () => this.runScreenplayImporter();
    document.getElementById("btn_llm_run_debugger").onclick = () => this.runLogicDebugger();
    
    // Editor Playback Buttons
    document.getElementById("btn_start_play").onclick = () => this.startPlayback();
    document.getElementById("btn_stop_play").onclick = () => this.stopPlayback();
    document.getElementById("btn_toggle_diary").onclick = () => this.toggleDiaryPanel();
    
    // Project imports/exports
    document.getElementById("btn_export_project").onclick = () => this.exportProject();
    document.getElementById("btn_import_project").onclick = () => this.importProject();
    
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
  }
};
