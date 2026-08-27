import {
  Component,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TFile
} from "obsidian";

const PROPERTY = "wordbook-layout";
const LEGACY_PROPERTY = "单词书布局";
const REFRESH_DELAY = 40;
const ANNOTATION_SCHEME = "obsidian-annotation:";

function decodeAnnotation(encoded: string): string {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function annotationFromHref(href: string | null): string | null {
  if (!href?.startsWith(ANNOTATION_SCHEME)) return null;
  try {
    return decodeAnnotation(href.slice(ANNOTATION_SCHEME.length));
  } catch (error: unknown) {
    console.error("Wordbook Layout: could not decode annotation", error);
    return null;
  }
}

class AnnotationPopover {
  element: HTMLDivElement | null = null;
  anchor: HTMLAnchorElement | null = null;

  open(anchor: HTMLAnchorElement, annotation: string): void {
    this.close();
    this.anchor = anchor;
    anchor.addClass("is-wordbook-annotation-active");

    const popover = document.body.createDiv({ cls: "wordbook-annotation-popover" });
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "批注");
    this.element = popover;

    const body = popover.createDiv({ cls: "wordbook-annotation-popover-body" });
    this.renderAnnotation(body, annotation);
    this.position();

    window.requestAnimationFrame(() => {
      if (this.element === popover) popover.addClass("is-visible");
    });
  }

  private renderAnnotation(body: HTMLElement, annotation: string): void {
    const lines = annotation.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines) {
      const separator = line.indexOf("｜");
      if (separator <= 0) {
        body.createDiv({ cls: "wordbook-annotation-popover-line", text: line });
        continue;
      }

      const label = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      const row = body.createDiv({ cls: "wordbook-annotation-popover-row" });
      if (label === "中文义") row.addClass("is-meaning");
      row.createSpan({ cls: "wordbook-annotation-popover-label", text: label });
      row.createSpan({ cls: "wordbook-annotation-popover-value", text: value });
    }
  }

  position(): void {
    if (!this.element || !this.anchor?.isConnected) {
      this.close();
      return;
    }

    const isMobile = Platform.isMobile || window.innerWidth <= 600;
    this.element.toggleClass("is-mobile", isMobile);
    if (isMobile) {
      this.element.removeClass("is-left", "is-right");
      this.element.style.left = "10px";
      this.element.style.right = "10px";
      this.element.style.top = "auto";
      this.element.style.bottom = "calc(84px + env(safe-area-inset-bottom, 0px))";
      this.element.style.width = "auto";
      this.element.style.minWidth = "0";
      this.element.style.maxWidth = "none";
      return;
    }

    const viewportMargin = 12;
    const anchorGap = 34;
    const preferredMinimumWidth = 170;
    const absoluteMinimumWidth = 140;
    const maximumWidth = 440;
    const anchorRect = this.anchor.getBoundingClientRect();
    const rightSpace = window.innerWidth - anchorRect.right - anchorGap - viewportMargin;
    const leftSpace = anchorRect.left - anchorGap - viewportMargin;
    const useRight = rightSpace >= preferredMinimumWidth || rightSpace >= leftSpace;
    const availableWidth = Math.max(absoluteMinimumWidth, useRight ? rightSpace : leftSpace);
    const maxWidth = Math.min(maximumWidth, availableWidth);
    const minWidth = Math.min(preferredMinimumWidth, maxWidth);

    this.element.toggleClass("is-right", useRight);
    this.element.toggleClass("is-left", !useRight);
    this.element.style.removeProperty("right");
    this.element.style.removeProperty("bottom");
    this.element.style.width = "max-content";
    this.element.style.minWidth = `${Math.floor(minWidth)}px`;
    this.element.style.maxWidth = `${Math.floor(maxWidth)}px`;

    const popoverRect = {
      width: this.element.offsetWidth,
      height: this.element.offsetHeight
    };
    const desiredTop = anchorRect.top + anchorRect.height / 2 - popoverRect.height / 2;
    const maxTop = Math.max(viewportMargin, window.innerHeight - popoverRect.height - viewportMargin);
    const top = Math.min(Math.max(desiredTop, viewportMargin), maxTop);
    const desiredLeft = useRight
      ? anchorRect.right + anchorGap
      : anchorRect.left - anchorGap - popoverRect.width;
    const maxLeft = Math.max(viewportMargin, window.innerWidth - popoverRect.width - viewportMargin);
    const left = Math.min(Math.max(desiredLeft, viewportMargin), maxLeft);
    const arrowY = Math.min(
      Math.max(anchorRect.top + anchorRect.height / 2 - top, 22),
      Math.max(22, popoverRect.height - 22)
    );

    this.element.style.left = `${Math.round(left)}px`;
    this.element.style.top = `${Math.round(top)}px`;
    this.element.style.setProperty("--wordbook-annotation-arrow-y", `${Math.round(arrowY)}px`);
  }

  contains(target: EventTarget | null): boolean {
    return target instanceof Node && Boolean(this.element?.contains(target));
  }

  isOpenFor(anchor: HTMLAnchorElement): boolean {
    return Boolean(this.element && this.anchor === anchor);
  }

  close(): void {
    this.anchor?.removeClass("is-wordbook-annotation-active");
    this.element?.remove();
    this.element = null;
    this.anchor = null;
  }
}

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
  private annotationPopover = new AnnotationPopover();
  private lastTouchLink: HTMLAnchorElement | null = null;
  private lastTouchAt = 0;
  private touchCandidate: {
    link: HTMLAnchorElement;
    pointerId: number;
    x: number;
    y: number;
  } | null = null;

  async onload(): Promise<void> {
    this.addCommand({
      id: "toggle-current-note",
      name: "Toggle layout for the current note",
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

    this.registerDomEvent(document, "pointerdown", (event) => {
      if (this.hasLegacyAnnotationPlugin()) return;
      const link = this.getAnnotationLink(event.target);
      if (link && event.pointerType !== "mouse") {
        this.touchCandidate = {
          link,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY
        };
      } else {
        this.touchCandidate = null;
      }
      if (!this.annotationPopover.contains(event.target) && !link) {
        this.annotationPopover.close();
      }
    }, true);
    this.registerDomEvent(document, "pointerup", (event) => {
      if (this.hasLegacyAnnotationPlugin() || event.pointerType === "mouse") return;
      const link = this.getAnnotationLink(event.target);
      const candidate = this.touchCandidate;
      this.touchCandidate = null;
      if (
        !link ||
        !candidate ||
        candidate.link !== link ||
        candidate.pointerId !== event.pointerId ||
        Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > 12
      ) return;
      event.preventDefault();
      event.stopPropagation();
      this.lastTouchLink = link;
      this.lastTouchAt = window.performance.now();
      this.toggleAnnotationPopover(link);
    }, true);
    this.registerDomEvent(document, "pointercancel", () => {
      this.touchCandidate = null;
    }, true);
    this.registerDomEvent(document, "click", (event) => {
      if (this.hasLegacyAnnotationPlugin()) return;
      const link = this.getAnnotationLink(event.target);
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      const wasHandledByTouch =
        this.lastTouchLink === link && window.performance.now() - this.lastTouchAt < 800;
      this.lastTouchLink = null;
      if (!wasHandledByTouch) this.toggleAnnotationPopover(link);
    }, true);
    this.registerDomEvent(document, "keydown", (event) => {
      if (this.hasLegacyAnnotationPlugin() || (event.key !== "Enter" && event.key !== " ")) return;
      const link = this.getAnnotationLink(event.target);
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      this.toggleAnnotationPopover(link);
    }, true);
    this.registerDomEvent(document, "scroll", (event) => {
      if (!this.annotationPopover.element || this.annotationPopover.contains(event.target)) return;
      this.annotationPopover.close();
    }, true);
    this.registerDomEvent(window, "resize", () => this.annotationPopover.position());

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
      this.decorateAnnotationLinks(container);
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
    const grid = container.createDiv({ cls: "wordbook-layout-grid" });
    let section: HTMLElement | null = null;
    let preamble: HTMLElement | null = null;

    for (const node of nodes) {
      if (node.tagName === `H${sectionLevel}`) {
        section = grid.createEl("section", { cls: "wordbook-layout-section" });
      } else if (!section && !preamble) {
        preamble = grid.createDiv({ cls: "wordbook-layout-preamble" });
      }
      (section ?? preamble)?.appendChild(node);
    }
  }

  private hasLegacyAnnotationPlugin(): boolean {
    const pluginManager = (this.app as unknown as {
      plugins?: { plugins?: Record<string, unknown> };
    }).plugins;
    return Boolean(pluginManager?.plugins?.["inline-annotation-popup"]);
  }

  private getAnnotationLink(target: EventTarget | null): HTMLAnchorElement | null {
    if (!(target instanceof Element)) return null;
    const link = target.closest<HTMLAnchorElement>(`a[href^="${ANNOTATION_SCHEME}"]`);
    return link?.isConnected ? link : null;
  }

  private decorateAnnotationLinks(container: HTMLElement): void {
    container.querySelectorAll<HTMLAnchorElement>(`a[href^="${ANNOTATION_SCHEME}"]`)
      .forEach((link) => {
        link.addClass("wordbook-annotation-link");
        link.removeClass("external-link");
        link.removeAttribute("target");
        link.removeAttribute("rel");
        link.removeAttribute("title");
        link.removeAttribute("data-tooltip-position");
        link.setAttribute("role", "button");
        link.setAttribute("tabindex", "0");
        link.setAttribute("aria-label", `查看 ${link.textContent ?? "此词"} 的批注`);
      });
  }

  private toggleAnnotationPopover(link: HTMLAnchorElement): void {
    if (this.annotationPopover.isOpenFor(link)) {
      this.annotationPopover.close();
      return;
    }
    const annotation = annotationFromHref(link.getAttribute("href"));
    if (annotation === null) {
      new Notice("这条批注无法读取，可能已损坏");
      return;
    }
    this.annotationPopover.open(link, annotation);
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
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
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
      if (this.annotationPopover.anchor && record.container.contains(this.annotationPopover.anchor)) {
        this.annotationPopover.close();
      }
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
    this.annotationPopover.close();
    for (const view of Array.from(this.layouts.keys())) this.cleanupView(view);
  }
}
