// Run only against the local BOLD_TEST site with the demo Firebase emulators.
import { always, eventually } from "@antithesishq/bombadil";
import { actions, extract, registerCustomAction } from "@antithesishq/bombadil/browser";
export { noUncaughtExceptions, noUnhandledPromiseRejections } from "@antithesishq/bombadil/browser/defaults";

const screen = extract(({ document: d, window: w }) => ({
  demo: !!d.querySelector("#testBar"), picker: !!d.querySelector(".test-picker"),
  signedOut: d.querySelector("#testBar")?.textContent?.includes("signed out") ?? false,
  form: !!d.querySelector("#pbInputs:not(:disabled)"), confirm: !!d.querySelector("dialog[open] [data-key=reminders]"),
  detail: !!d.querySelector("#addVerifier"), canStartVerifier: !!d.querySelector("#addVerifier:enabled"), add: !!d.querySelector("#pbAdd[href]"),
  consent: !!d.querySelector("dialog[open] [data-yes]"),
  badge: !!d.querySelector("#problemBody .pb-missing"),
  overview: d.querySelector("#problemBody [data-tab=overview]")?.getAttribute("aria-selected") === "true",
  problemText: d.querySelector("#problemPanel")?.textContent || "",
  remindersChecked: !!d.querySelector("dialog [data-key=reminders]:checked"),
  steps: d.querySelectorAll("#problemBody .pb-steps li").length,
  extraPanels: Array.from(d.querySelectorAll("#problems:not([hidden]) [role=tabpanel][hidden]"))
    .some(panel => w.getComputedStyle(panel).display !== "none"),
  revisiting: w.sessionStorage.getItem("bombadil-problem-visited") === "yes",
  missing: Array.from(d.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("#pbCreate [required]")).filter(x => !x.value.trim()).map(x => x.id),
}));
export const opensSavedProblem = eventually(() => screen.current.detail).within(55, "seconds");
export const showsOnlySelectedStage = always(() => !screen.current.extraPanels);
export const savedProblemHasVerifierAction = always(() => !screen.current.detail || (screen.current.badge && screen.current.canStartVerifier && screen.current.steps === 3));
export const savedProblemKeepsDifficulties = always(() =>
  !screen.current.detail || !screen.current.overview || screen.current.problemText.includes("Noise obscures slow decay."));

const click = registerCustomAction("clickProblemControl", async (d, w, selector: string) => {
  if (!["localhost","127.0.0.1"].includes(w.location.hostname) || !d.querySelector("#testBar")) throw Error("Demo site required");
  if (selector === ".detail-back") w.sessionStorage.setItem("bombadil-problem-visited","yes");
  d.querySelector<HTMLElement>(selector)?.click();
});
const fill = registerCustomAction("fillProblemField", async (d, w, id: string) => {
  if (!["localhost","127.0.0.1"].includes(w.location.hostname) || !d.querySelector("#testBar")) throw Error("Demo site required");
  const input = d.getElementById(id);
  if (id === "pbDefiner" && input instanceof HTMLSelectElement) input.selectedIndex = 1;
  else if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
    switch (id) {
      case "pbTitle": input.value = "Bombadil kinetics fixture"; break;
      case "pbWhy": input.value = "Measure rates with fewer observations."; break;
      case "pbDifficulties": input.value = "Noise obscures slow decay."; break;
      case "pbExisting": input.value = "Least squares fits clean traces."; break;
      default: throw Error("Unexpected required problem field: " + id);
    }
  } else throw Error("Missing problem control: " + id);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
export const exercise = actions(() => {
  const s = screen.current;
  if (!s.demo) return ["Wait"];
  if (s.picker) return [click(".test-picker [data-i='1']")];
  if (s.signedOut) return [click("#testBar [data-switch]")];
  if (s.add && s.revisiting) return ['[data-view="list"].view-btn','[data-view="grid"].view-btn',
    '[data-tab=open]','[data-tab=implemented]','[data-tab=checked]','[data-tab=validated]','[data-tab=archived]'].map(selector => click(selector));
  if (s.add) return [click("#pbAdd")];
  if (s.confirm && s.remindersChecked) return [click("dialog [data-key=reminders]")];
  if (s.confirm) return [click("dialog [data-yes]"), click("dialog [data-yes]"), click("dialog [data-no]")];
  if (s.form) return s.missing.length ? s.missing.map(fillField => fill(fillField)) : [click("#pbCreate [type=submit]")];
  if (s.consent) return [click("dialog [data-no]")];
  if (s.detail) return [click(".detail-back"), click("#addVerifier"), click("[data-tab=releases]"), click("[data-tab=history]"), click("[data-tab=overview]")];
  return ["Wait"];
});
