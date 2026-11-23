// Run only against the local BOLD_TEST site with the demo Firebase emulators.
import { always, eventually } from "@antithesishq/bombadil";
import { actions, extract, registerCustomAction } from "@antithesishq/bombadil/browser";
export { noUncaughtExceptions, noUnhandledPromiseRejections } from "@antithesishq/bombadil/browser/defaults";

const screen = extract(({ document: d }) => ({
  demo: !!d.querySelector("#testBar"), picker: !!d.querySelector(".test-picker"),
  signedOut: !!d.querySelector("#testBar") && d.querySelector("#testBar")!.textContent!.includes("signed out"),
  form: !!d.querySelector("#pbInputs:not(:disabled)"), confirm: !!d.querySelector("dialog[open] [data-key=reminders]"),
  detail: !!d.querySelector("#addVerifier"), add: !!d.querySelector("#pbAdd[href]"),
  consent: !!d.querySelector("dialog[open] [data-yes]"),
  badge: !!d.querySelector("#problemBody .pb-missing"),
  steps: d.querySelectorAll("#problemBody .pb-steps li").length,
  missing: Array.from(d.querySelectorAll<HTMLInputElement>("#pbCreate [required]")).filter(x => !x.value).map(x => x.id),
}));
export const opensSavedProblem = eventually(() => screen.current.detail).within(55, "seconds");
export const savedProblemHasVerifierAction = always(() => !screen.current.detail || (screen.current.badge && screen.current.steps === 3));

const click = registerCustomAction("clickProblemControl", async (d, w, selector: string) => {
  if (!["localhost","127.0.0.1"].includes(w.location.hostname) || !d.querySelector("#testBar")) throw Error("Demo site required");
  d.querySelector<HTMLElement>(selector)?.click();
});
const fill = registerCustomAction("fillProblemField", async (d, w, id: string) => {
  if (!["localhost","127.0.0.1"].includes(w.location.hostname) || !d.querySelector("#testBar")) throw Error("Demo site required");
  const input = d.getElementById(id) as HTMLInputElement | HTMLSelectElement;
  if (input instanceof HTMLSelectElement) input.selectedIndex = 1;
  else input.value = ({pbTitle:"Bombadil kinetics fixture", pbQuestion:"Estimate a decay rate from a signal.",
    pbWhy:"Measure rates with fewer observations.", pbExisting:"Least squares fits clean traces."} as Record<string,string>)[id];
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
export const exercise = actions(() => {
  const s = screen.current;
  if (!s.demo) return ["Wait"];
  if (s.picker) return [click(".test-picker [data-i='1']")];
  if (s.signedOut) return [click("#testBar [data-switch]")];
  if (s.add) return [click("#pbAdd")];
  if (s.confirm) return [click("dialog [data-yes]"), click("dialog [data-yes]"), click("dialog [data-no]")];
  if (s.form) return s.missing.length ? s.missing.map(fillField => fill(fillField)) : [click("#pbCreate [type=submit]")];
  if (s.consent) return [click("dialog [data-no]")];
  if (s.detail) return [click("#addVerifier"), click("[data-tab=releases]"), click("[data-tab=history]"), click("[data-tab=overview]")];
  return ["Wait"];
});
