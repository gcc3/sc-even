import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { Settings } from "../utils/setting";
import { saveSettings } from "../utils/setting";
import { t } from "../i18n";

export function userModalHTML(): string {
  return `
    <div class="modal" data-login-modal>
      <div class="modal__box">
        <h2 class="modal__title" data-i18n-modal-title>${t("loginTitle")}</h2>

        <div class="modal__view" data-login-view>
          <label class="field">
            <span class="field__label" data-i18n-username>${t("fieldUsername")}</span>
            <input class="field__input" data-username type="text" autocomplete="username" />
          </label>
          <label class="field">
            <span class="field__label" data-i18n-password>${t("fieldPassword")}</span>
            <input class="field__input" data-password type="password" autocomplete="current-password" />
          </label>
          <label class="checkbox">
            <input type="checkbox" data-login-save />
            <span data-i18n-save-creds>${t("saveCredentials")}</span>
          </label>
          <div class="modal__actions">
            <button class="btn-link" data-show-register data-i18n-register-btn>${t("btnRegister")}</button>
            <button class="btn" data-close-login data-i18n-cancel>${t("btnCancel")}</button>
            <button class="btn btn--primary" data-do-login data-i18n-login-btn>${t("btnLogin")}</button>
          </div>
        </div>

        <div class="modal__view" data-register-view style="display:none">
          <label class="field">
            <span class="field__label" data-i18n-email>${t("fieldEmail")}</span>
            <input class="field__input" data-reg-email type="email" autocomplete="email" />
          </label>
          <label class="field">
            <span class="field__label" data-i18n-reg-username>${t("fieldUsername")}</span>
            <input class="field__input" data-reg-username type="text" autocomplete="username" />
          </label>
          <label class="field">
            <span class="field__label" data-i18n-reg-password>${t("fieldPassword")}</span>
            <input class="field__input" data-reg-password type="password" autocomplete="new-password" />
            <span class="field__hint" data-i18n-password-hint>${t("passwordHint")}</span>
          </label>
          <div class="modal__actions">
            <button class="btn" data-show-login data-i18n-cancel>${t("btnCancel")}</button>
            <button class="btn btn--primary" data-do-register data-i18n-register-btn>${t("btnRegister")}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export interface UserModalCallbacks {
  onLogin: (username: string, password: string) => void;
  onRegister: (username: string, email: string, password: string) => void;
}

export function createUserModal(
  root: HTMLElement,
  settingsRef: { current: Settings },
  bridge: EvenAppBridge,
  callbacks: UserModalCallbacks,
) {
  const loginModal = root.querySelector<HTMLDivElement>("[data-login-modal]")!;
  const usernameInput = loginModal.querySelector<HTMLInputElement>("[data-username]")!;
  const passwordInput = loginModal.querySelector<HTMLInputElement>("[data-password]")!;
  const loginSaveCheckbox = loginModal.querySelector<HTMLInputElement>("[data-login-save]")!;
  const loginView = loginModal.querySelector<HTMLDivElement>("[data-login-view]")!;
  const registerView = loginModal.querySelector<HTMLDivElement>("[data-register-view]")!;
  const modalTitle = loginModal.querySelector<HTMLHeadingElement>("[data-i18n-modal-title]")!;
  const regEmailInput = loginModal.querySelector<HTMLInputElement>("[data-reg-email]")!;
  const regUsernameInput = loginModal.querySelector<HTMLInputElement>("[data-reg-username]")!;
  const regPasswordInput = loginModal.querySelector<HTMLInputElement>("[data-reg-password]")!;

  const showLoginView = () => {
    loginView.style.display = "";
    registerView.style.display = "none";
    modalTitle.textContent = t("loginTitle");
  };
  const showRegisterView = () => {
    loginView.style.display = "none";
    registerView.style.display = "";
    modalTitle.textContent = t("registerTitle");
  };

  const open = () => {
    usernameInput.value = settingsRef.current.username;
    passwordInput.value = settingsRef.current.password;
    loginSaveCheckbox.checked = settingsRef.current.loginSave;
    showLoginView();
    loginModal.classList.add("modal--open");
  };
  const close = () => loginModal.classList.remove("modal--open");

  loginModal.querySelector("[data-close-login]")!.addEventListener("click", close);
  loginModal.querySelector("[data-show-register]")!.addEventListener("click", showRegisterView);
  loginModal.querySelector("[data-show-login]")!.addEventListener("click", showLoginView);
  loginModal.addEventListener("click", (e) => {
    if (e.target === loginModal) close();
  });

  loginModal.querySelector("[data-do-login]")!.addEventListener("click", async () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    const save = loginSaveCheckbox.checked;
    // Persist the credentials only when "Save" is checked; otherwise forget any
    // previously stored ones so this is a one-session login (no auto-login next time).
    settingsRef.current = save
      ? { ...settingsRef.current, username, password, loginSave: true }
      : { ...settingsRef.current, username: "", password: "", loginSave: false };
    await saveSettings(bridge, settingsRef.current);
    if (username) callbacks.onLogin(username, password);
    close();
  });

  loginModal.querySelector("[data-do-register]")!.addEventListener("click", () => {
    const username = regUsernameInput.value.trim();
    const email = regEmailInput.value.trim();
    const password = regPasswordInput.value;
    if (username && email && password) callbacks.onRegister(username, email, password);
    regEmailInput.value = "";
    regUsernameInput.value = "";
    regPasswordInput.value = "";
    close();
  });

  return {
    open,
    applyTranslations() {
      modalTitle.textContent = registerView.style.display === "none" ? t("loginTitle") : t("registerTitle");
      loginModal.querySelector("[data-i18n-username]")!.textContent = t("fieldUsername");
      loginModal.querySelector("[data-i18n-password]")!.textContent = t("fieldPassword");
      loginModal.querySelector("[data-i18n-save-creds]")!.textContent = t("saveCredentials");
      loginModal.querySelectorAll("[data-i18n-cancel]").forEach((el) => (el.textContent = t("btnCancel")));
      loginModal.querySelector("[data-i18n-login-btn]")!.textContent = t("btnLogin");
      loginModal.querySelectorAll("[data-i18n-register-btn]").forEach((el) => (el.textContent = t("btnRegister")));
      loginModal.querySelector("[data-i18n-email]")!.textContent = t("fieldEmail");
      loginModal.querySelector("[data-i18n-reg-username]")!.textContent = t("fieldUsername");
      loginModal.querySelector("[data-i18n-reg-password]")!.textContent = t("fieldPassword");
      loginModal.querySelector("[data-i18n-password-hint]")!.textContent = t("passwordHint");
    },
  };
}
