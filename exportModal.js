let cachedEls = null;

function getEls() {
  if (cachedEls) return cachedEls;
  cachedEls = {
    backdrop: document.getElementById('modal-backdrop'),
    popup: document.getElementById('export-popup'),
    input: document.getElementById('export-filename-input'),
    closeBtn: document.getElementById('export-close-btn'),
    cancelBtn: document.getElementById('export-cancel-btn'),
    confirmBtn: document.getElementById('export-confirm-btn'),
  };
  return cachedEls;
}

/** 저장 대화상자 대신, 내보낼 파일 이름을 확인/수정하는 작은 모달을 띄운다. */
export function promptExportFileName(defaultFileName) {
  const { backdrop, popup, input, closeBtn, cancelBtn, confirmBtn } = getEls();

  return new Promise((resolve) => {
    input.value = defaultFileName;
    backdrop.hidden = false;
    popup.hidden = false;
    input.focus();
    input.select();

    function cleanup(result) {
      backdrop.hidden = true;
      popup.hidden = true;
      closeBtn.removeEventListener('click', onCancel);
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      input.removeEventListener('keydown', onKeydown);
      resolve(result);
    }
    function onCancel() {
      cleanup(null);
    }
    function onConfirm() {
      const name = input.value.trim();
      cleanup(name || defaultFileName);
    }
    function onKeydown(evt) {
      if (evt.key === 'Enter') onConfirm();
      if (evt.key === 'Escape') onCancel();
    }

    closeBtn.addEventListener('click', onCancel);
    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
    input.addEventListener('keydown', onKeydown);
  });
}
