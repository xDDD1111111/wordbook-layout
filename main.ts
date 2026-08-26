import {
  Component,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  Plugin,
  TFile
} from "obsidian";

const PROPERTY = "wordbook-layout";
const LEGACY_PROPERTY = "单词书布局";
const REFRESH_DELAY = 40;

interface WordbookRecord {
  component: Component;
  container: HTMLDivElement;
  preview: HTMLElement;
  path: string;
  source: string;
}

export default class WordbookLayoutPlugin extends Plugin {
  private layouts = new Map<MarkdownView, WordbookRecord>();
  private refreshTimer: number | null = null;
  private searchTimer: number | null = null;
  private searchHit: HTMLElement | null = null;
  private taskUpdateQueue: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    this.addCommand({
      id: "toggle-current-note",
      name: "Toggle wordbook layout for the current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.toggleCurrentNote(file);
        return true;
      }
    });

    this.registerEvent(this.app.workspace.on("file-open", () => this.queueRefresh()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.queueRefresh()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.queueRefresh()));
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file.extension === "md") this.queueRefresh(90);
      })
    );

    this.registerDomEvent(document, "input", (event) => {
      if (event.target instanceof HTMLInputElement && event.target.closest(".document-search-input")) {
        this.queueSearchSync(180);
      }
    }, true);
    this.registerDomEvent(document, "click", (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(".document-search-close-button")) this.clearSearchHit();
      if (event.target.closest(".document-search-button")) this.queueSearchSync(40);
    }, true);
    this.registerDomEvent(document, "keydown", (event) => {
      const inSearch = event.target instanceof HTMLInputElement && event.target.closest(".document-search-input");
      if ((inSearch && (event.key === "Enter" || event.key === "Escape")) || event.key === "F3") {
        this.queueSearchSync(40);
      }
    }, true);

    this.app.workspace.onLayoutReady(() => this.queueRefresh(0));
    this.register(() => this.cleanup());
  }

  private async toggleCurrentNote(file: TFile): Promise<void> {
    let enabled = false;
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const current = frontmatter[PROPERTY] === true || frontmatter[LEGACY_PROPERTY] === true;
      enabled = !current;
      frontmatter[PROPERTY] = enabled;
      if (LEGACY_PROPERTY in frontmatter) delete frontmatter[LEGACY_PROPERTY];
    });
    new Notice(enabled ? "Wordbook layout enabled" : "Wordbook layout disabled");
    this.queueRefresh(0);
  }

  private queueRefresh(delay = REFRESH_DELAY): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshLayouts();
    }, delay);
  }

  private async refreshLayouts(): Promise<void> {
    const views = this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView);
    const liveViews = new Set(views);

    for (const view of this.layouts.keys()) {
      if (!liveViews.has(view)) this.cleanupView(view);
    }
    for (const view of views) await this.refreshView(view);
  }

  private isEnabled(file: TFile): boolean {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return frontmatter?.[PROPERTY] === true || frontmatter?.[PROPERTY] === "true" ||
      frontmatter?.[LEGACY_PROPERTY] === true || frontmatter?.[LEGACY_PROPERTY] === "true";
  }

  private async refreshView(view: MarkdownView): Promise<void> {
    const file = view.file;
    const preview = view.containerEl.querySelector<HTMLElement>(".markdown-preview-view");
    if (!file || view.getMode() !== "preview" || !preview || !this.isEnabled(file)) {
      this.cleanupView(view);
      return;
    }

    const tracked = this.layouts.get(view)?.container;
    preview.querySelectorAll<HTMLElement>(":scope > .wordbook-layout-container").forEach((container) => {
      if (container !== tracked) container.remove();
    });

    const source = await this.app.vault.cachedRead(file);
    const current = this.layouts.get(view);
    if (current?.container.isConnected && current.preview === preview && current.path === file.path && current.source === source) {
      return;
    }

    this.cleanupView(view);
    const component = new Component();
    component.load();
    const container = preview.createDiv({ cls: "wordbook-layout-container" });
    preview.addClass("is-wordbook-layout");
    const record: WordbookRecord = { component, container, preview, path: file.path, source };
    this.layouts.set(view, record);

    try {
      await MarkdownRenderer.render(this.app, this.removeFrontmatter(source), container, file.path, component);
      if (this.layouts.get(view) !== record || !container.isConnected) return;
      this.organizeSections(container);
      this.bindTasks(container, file, source, component);
    } catch (error) {
      console.error("Wordbook Layout: failed to render layout", error);
      this.cleanupView(view);
    }
  }

  private removeFrontmatter(source: string): string {
    if (!source.startsWith("---")) return source;
    const match = source.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    return match ? source.slice(match[0].length) : source;
  }

  private organizeSections(container: HTMLElement): void {
    const nodes = Array.from(container.children);
    const levels = nodes
      .filter((node) => /^H[1-6]$/.test(node.tagName))
      .map((node) => Number(node.tagName.slice(1)));
    if (levels.length === 0) {
      container.addClass("has-no-headings");
      return;
    }

    const sectionLevel = Math.min(...levels);
    const grid = document.createElement("div");
    grid.className = "wordbook-layout-grid";
    let section: HTMLElement | null = null;
    let preamble: HTMLElement | null = null;

    for (const node of nodes) {
      if (node.tagName === `H${sectionLevel}`) {
        section = document.createElement("section");
        section.className = "wordbook-layout-section";
        grid.appendChild(section);
      } else if (!section && !preamble) {
        preamble = document.createElement("div");
        preamble.className = "wordbook-layout-preamble";
        grid.appendChild(preamble);
      }
      (section ?? preamble)?.appendChild(node);
    }
    container.appendChild(grid);
  }

  private bindTasks(container: HTMLElement, file: TFile, source: string, component: Component): void {
    const taskLines: number[] = [];
    source.split(/\r?\n/).forEach((line, index) => {
      if (/^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]/.test(line)) taskLines.push(index);
    });

    container.querySelectorAll<HTMLInputElement>("input.task-list-item-checkbox, input[type='checkbox']")
      .forEach((checkbox, index) => {
        const line = taskLines[index];
        if (line !== undefined) checkbox.dataset.wordbookTaskLine = String(line);
      });

    const handleClick = (event: Event): void => {
      const checkbox = event.target;
      if (checkbox instanceof HTMLInputElement && checkbox.dataset.wordbookTaskLine !== undefined) {
        event.stopPropagation();
      }
    };
    const handleChange = (event: Event): void => {
      const checkbox = event.target;
      if (!(checkbox instanceof HTMLInputElement)) return;
      const line = Number(checkbox.dataset.wordbookTaskLine);
      if (!Number.isInteger(line)) return;
      this.taskUpdateQueue = this.taskUpdateQueue
        .then(() => this.updateTask(file, line, checkbox.checked, container.closest<HTMLElement>(".markdown-preview-view")))
        .catch((error) => console.error("Wordbook Layout: failed to update task", error));
    };

    container.addEventListener("click", handleClick, true);
    container.addEventListener("change", handleChange, true);
    component.register(() => {
      container.removeEventListener("click", handleClick, true);
      container.removeEventListener("change", handleChange, true);
    });
  }

  private async updateTask(file: TFile, lineIndex: number, checked: boolean, preview: HTMLElement | null): Promise<void> {
    const scrollTop = preview?.scrollTop ?? 0;
    await this.app.vault.process(file, (source) => {
      const newline = source.includes("\r\n") ? "\r\n" : "\n";
      const lines = source.split(/\r?\n/);
      const line = lines[lineIndex];
      if (line === undefined) return source;
      lines[lineIndex] = line.replace(
        /^(\s*(?:[-+*]|\d+[.)])\s+\[)[ xX](\])/,
        `$1${checked ? "x" : " "}$2`
      );
      return lines.join(newline);
    });
    this.restoreScroll(preview, scrollTop);
  }

  private restoreScroll(preview: HTMLElement | null, scrollTop: number): void {
    if (!preview?.isConnected) return;
    preview.scrollTop = scrollTop;
    window.requestAnimationFrame(() => {
      if (preview.isConnected) preview.scrollTop = scrollTop;
    });
  }

  private queueSearchSync(delay: number): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      this.syncSearchResult();
    }, delay);
  }

  private syncSearchResult(): void {
    const view = this.app.workspace.activeLeaf?.view;
    if (!(view instanceof MarkdownView)) return;
    const record = this.layouts.get(view);
    if (!record?.container.isConnected) {
      this.clearSearchHit();
      return;
    }

    const search = view.containerEl.querySelector(".document-search-container");
    const input = search?.querySelector<HTMLInputElement>(".document-search-input input");
    const countText = search?.querySelector(".document-search-count")?.textContent ?? "";
    const count = countText.match(/(\d+)\s*\/\s*(\d+)/);
    const query = input?.value ?? "";
    const index = count ? Number(count[1]) - 1 : -1;
    if (!query || index < 0 || !count || Number(count[2]) <= 0) {
      this.clearSearchHit();
      return;
    }

    const target = this.findOccurrence(record.container, query, index);
    if (!target) {
      this.clearSearchHit();
      return;
    }
    this.clearSearchHit();
    this.searchHit = target;
    target.addClass("wordbook-layout-search-hit");
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  private findOccurrence(container: HTMLElement, query: string, targetIndex: number): HTMLElement | null {
    const needle = query.toLocaleLowerCase();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        return parent && !parent.closest("style, script") && node.nodeValue?.toLocaleLowerCase().includes(needle)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });
    let occurrence = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue?.toLocaleLowerCase() ?? "";
      let offset = 0;
      while ((offset = text.indexOf(needle, offset)) !== -1) {
        if (occurrence === targetIndex) return node.parentElement;
        occurrence += 1;
        offset += Math.max(needle.length, 1);
      }
    }
    return null;
  }

  private clearSearchHit(): void {
    this.searchHit?.removeClass("wordbook-layout-search-hit");
    this.searchHit = null;
  }

  private cleanupView(view: MarkdownView): void {
    const record = this.layouts.get(view);
    if (record) {
      this.layouts.delete(view);
      if (record.container.contains(this.searchHit)) this.clearSearchHit();
      record.component.unload();
    }
    const preview = record?.preview ?? view.containerEl.querySelector<HTMLElement>(".markdown-preview-view");
    preview?.removeClass("is-wordbook-layout");
    preview?.querySelectorAll(":scope > .wordbook-layout-container").forEach((container) => container.remove());
  }

  private cleanup(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.clearSearchHit();
    for (const view of Array.from(this.layouts.keys())) this.cleanupView(view);
  }
}
