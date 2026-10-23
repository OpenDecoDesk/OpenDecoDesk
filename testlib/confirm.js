// The admin asks yes / no questions in its own window (askConfirm_ → confirmModal_ in admin.js), not with
// window.confirm. A test that used to stub window.confirm calls autoConfirm(win, answer) instead: answer(message)
// is called with the question's full text whenever one opens, and its true / false presses Yes or Cancel.
// Calling it again on the same window just swaps the answer.
function autoConfirm(win, answer) {
  win.__confirmAnswer = answer;
  if (win.__confirmObserver) return;
  const handle = () => {
    win.document.querySelectorAll(".confirm-modal:not([data-answered])").forEach((ov) => {
      if (!ov.dataset.message && ov.dataset.message !== "") return;
      ov.dataset.answered = "1";
      const yes = !!win.__confirmAnswer(ov.dataset.message || "");
      const btn = ov.querySelector(yes ? "#cmOk" : "#cmCancel");
      if (btn) btn.click();
    });
  };
  win.__confirmObserver = new win.MutationObserver(handle);
  win.__confirmObserver.observe(win.document, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-message"] });
}
module.exports = { autoConfirm };
