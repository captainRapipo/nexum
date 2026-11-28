import { Segmented } from "../ui";
import { SPEC_TABS, type SpecTabId } from "./specModel";

export const panelDomId = (id: SpecTabId) => `nx-spec-panel-${id}`;

const OPTIONS = SPEC_TABS.map((t) => ({ value: t.id, label: t.label }));

/** View tabs of the System page: the large segmented control (SPEC §16), arrow keys move the choice. */
export function SpecTabs({ value, onChange }: { value: SpecTabId; onChange: (id: SpecTabId) => void }) {
  return <Segmented value={value} options={OPTIONS} onChange={onChange} size="lg" ariaLabel="System details" />;
}

export default SpecTabs;
