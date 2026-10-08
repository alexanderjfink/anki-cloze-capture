/** Grow a textarea to fit its content so cards can be read by scrolling the list, not the box. */
export function autosize(el: HTMLTextAreaElement): void {
  el.style.overflowY = "hidden";
  el.style.resize = "none";
  el.style.height = "auto";
  // scrollHeight is 0 while hidden; skip so it gets sized on first visible render.
  const height = el.scrollHeight;
  if (height > 0) el.style.height = `${height}px`;
}

export function autosizeAll(root: ParentNode): void {
  root.querySelectorAll("textarea").forEach((el) => autosize(el as HTMLTextAreaElement));
}
