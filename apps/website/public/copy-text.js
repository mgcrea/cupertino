// Copies a button's `data-copy` to the clipboard and says so on the button.
//
// A file here rather than an inline <script>: the CSP allows `script-src 'self'`
// and Astro does not hash inline scripts, so an inline one would be blocked in
// the build and only in the build — see apps/website/CLAUDE.md.
for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const label = button.textContent;
    try {
      await navigator.clipboard.writeText(button.dataset.copy ?? "");
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    setTimeout(() => {
      button.textContent = label;
    }, 1600);
  });
}
