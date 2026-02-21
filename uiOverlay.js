(() => {
  class SceneOverlayManager {
    constructor(video) {
      this.video = video;
      this.root = null;
      this.previewEl = null;
      this.previewTimer = null;
    }

    ensureRoot() {
      const wrapper = this.video.parentElement;
      if (!wrapper) {
        return null;
      }

      const style = window.getComputedStyle(wrapper);
      if (style.position === "static") {
        wrapper.style.position = "relative";
      }

      if (!this.root || !this.root.isConnected) {
        const root = document.createElement("div");
        root.className = "sf-overlay-root";
        wrapper.appendChild(root);
        this.root = root;
      }

      return this.root;
    }

    banner(text, timeout = 1500) {
      const root = this.ensureRoot();
      if (!root) {
        return;
      }
      const el = document.createElement("div");
      el.className = "sf-status-banner";
      el.textContent = text;
      root.appendChild(el);
      setTimeout(() => {
        if (el.isConnected) {
          el.remove();
        }
      }, timeout);
    }

    incomingCountdown(secondsLeft) {
      this.banner(`Sensitive scene in ${secondsLeft}...`, 900);
    }

    showSkipPreview(delaySec, onSkipNow, onCancel) {
      const root = this.ensureRoot();
      if (!root) {
        return;
      }

      this.clearSkipPreview();

      const box = document.createElement("div");
      box.className = "sf-preview-box";
      box.innerHTML = `<strong>Sensitive scene detected (${delaySec}s)</strong><span>Skip?</span>`;

      const skipBtn = document.createElement("button");
      skipBtn.type = "button";
      skipBtn.textContent = "Skip";

      const keepBtn = document.createElement("button");
      keepBtn.type = "button";
      keepBtn.textContent = "Keep";

      const btnRow = document.createElement("div");
      btnRow.className = "sf-preview-buttons";
      btnRow.appendChild(skipBtn);
      btnRow.appendChild(keepBtn);
      box.appendChild(btnRow);

      skipBtn.addEventListener("click", () => {
        this.clearSkipPreview();
        onSkipNow?.();
      });

      keepBtn.addEventListener("click", () => {
        this.clearSkipPreview();
        onCancel?.();
      });

      root.appendChild(box);
      this.previewEl = box;
    }

    clearSkipPreview() {
      if (this.previewTimer) {
        clearTimeout(this.previewTimer);
        this.previewTimer = null;
      }
      if (this.previewEl?.isConnected) {
        this.previewEl.remove();
      }
      this.previewEl = null;
    }
  }

  window.SceneOverlayManager = SceneOverlayManager;
})();
