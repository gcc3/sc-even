// The saved theme, put on <html> before the first paint so a reload into a dark theme
// doesn't flash white. app.js re-applies it once it runs — this file is only about being
// early, which a module script (deferred by definition) cannot be.
try {
  const saved = localStorage.getItem("sc-theme");
  if (saved === "dark" || saved === "terminal") document.documentElement.dataset.theme = saved;
} catch {
  /* storage blocked: the default theme it is */
}
