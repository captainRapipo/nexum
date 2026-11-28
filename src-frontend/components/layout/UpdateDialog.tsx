// Update dialog (CONTRACT §2.15.7). Opened only by a click (the toolbar indicator, or "View update" in
// Settings): no dialog, toast or notification ever opens by itself. Nothing is downloaded before the
// click on "Install update"; Rust verifies the download against Nexum's signing key before anything runs.
import { useEffect, useState, type ReactNode } from "react";
import { UPDATE_ERROR_TEXT, UPDATE_RELEASES_URL, UPDATE_TEXT, type UpdateState } from "../../types";
import { api, errorMessage } from "../../lib/api";
import { fmtBytes, fmtDate } from "../../lib/format";
import { updateBusy, useUpdater } from "../../hooks/useUpdater";
import { toast } from "../feedback/Toast";
import { Button, InkLink, Modal, ProgressBar, ScrollFade, StatusIcon } from "../ui";

export interface UpdateDialogProps {
  open: boolean;
  onClose: () => void;
}

/** "Open the releases page": hands the URL to the default browser. Not a request made by Nexum. */
export function openReleasesPage(): void {
  api.openExternal(UPDATE_RELEASES_URL).catch((err) => toast(errorMessage(err), "warn"));
}

/** A version with a pre-release part ("1.3.0-preview.2") is a preview build. */
export function isPreviewVersion(version: string | null | undefined): boolean {
  return !!version && version.includes("-");
}

function Line({ children, tone = "secondary" }: { children: ReactNode; tone?: "secondary" | "tertiary" }) {
  return <p className={tone === "tertiary" ? "text-callout text-ink-3" : "text-body text-ink-2"}>{children}</p>;
}

function Offer({ update, current }: { update: UpdateState; current: string }) {
  const released = update.publishedAt ? fmtDate(update.publishedAt) : null;
  return (
    <div className="space-y-2.5">
      <Line>
        {UPDATE_TEXT.dialogCurrent.replace("{c}", current)}
        {released && released !== "—" ? ` Released ${released}.` : ""}
      </Line>
      {update.notes && (
        <div className="rounded-lg bg-inset px-3 py-2">
          <ScrollFade maxHeight={200}>
            {/* Plain text only: release notes are never rendered as HTML. */}
            <div className="text-callout whitespace-pre-wrap text-ink select-text">{update.notes}</div>
          </ScrollFade>
        </div>
      )}
      <Line tone="tertiary">{UPDATE_TEXT.dialogVerified}</Line>
      <Line tone="tertiary">{UPDATE_TEXT.dialogClose}</Line>
      {update.channel === "preview" && isPreviewVersion(update.latestVersion) && <Line tone="tertiary">{UPDATE_TEXT.dialogPreview}</Line>}
    </div>
  );
}

function Progress({ update }: { update: UpdateState }) {
  const downloading = update.state === "downloading";
  const text = downloading ? UPDATE_TEXT.downloading : update.state === "ready" ? UPDATE_TEXT.ready : UPDATE_TEXT.installing;
  const sizes =
    downloading && update.downloadedBytes != null
      ? update.totalBytes != null
        ? `${fmtBytes(update.downloadedBytes)} of ${fmtBytes(update.totalBytes)}`
        : fmtBytes(update.downloadedBytes)
      : null;
  return (
    <div className="pt-2">
      <ProgressBar value={downloading ? update.progress : 100} indeterminate={downloading && update.progress == null} label={text} />
      <div className="tnum mt-2 flex items-baseline justify-between gap-3 text-callout text-ink-2">
        {/* Only the step is announced (Downloading… → verified → installing): the byte counter changes
            four times a second and the progress bar already carries the percentage. */}
        <span role="status" aria-live="polite">
          {text}
        </span>
        {downloading && (
          <span className="text-ink-3">
            {sizes}
            {sizes && update.progress != null ? " · " : ""}
            {update.progress != null ? `${update.progress}%` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

export function UpdateDialog({ open, onClose }: UpdateDialogProps) {
  const { update, check, install } = useUpdater();
  /** Between the click and Rust's first state change. */
  const [pending, setPending] = useState(false);
  useEffect(() => setPending(false), [update.state, open]);

  const current = update.currentVersion || __NEXUM_VERSION__;
  const version = update.latestVersion;
  const busy = updateBusy(update);
  const title = version ? UPDATE_TEXT.dialogTitle.replace("{v}", version) : UPDATE_TEXT.sectionTitle;

  // The command returns as soon as Rust has started; the state change that follows clears `pending`
  // (effect above). The timer only covers a call that changed nothing (it was rejected).
  const run = (fn: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    void fn().finally(() => window.setTimeout(() => setPending(false), 1500));
  };

  let body: ReactNode;
  let footer: ReactNode = null;

  if (busy) {
    // Downloading, verified, installing: no buttons, and the dialog cannot be dismissed.
    body = <Progress update={update} />;
  } else if (update.state === "available") {
    body = <Offer update={update} current={current} />;
    footer = (
      <>
        <Button className="min-w-24" onClick={onClose} disabled={pending}>
          {UPDATE_TEXT.later}
        </Button>
        <Button variant="primary" className="min-w-24" loading={pending} onClick={() => run(install)}>
          {UPDATE_TEXT.install}
        </Button>
      </>
    );
  } else if (update.state === "error") {
    body = (
      <div className="flex items-start gap-2 text-body text-ink" role="alert">
        <StatusIcon tone="warn" size={16} className="mt-0.5" />
        <span>{update.error ?? UPDATE_ERROR_TEXT.unknown}</span>
      </div>
    );
    footer = (
      <>
        <InkLink className="mr-auto" onClick={openReleasesPage}>
          {UPDATE_TEXT.openReleases}
        </InkLink>
        <Button className="min-w-24" onClick={onClose} disabled={pending}>
          {UPDATE_TEXT.close}
        </Button>
        {/* An offer is still in memory: install it again. Otherwise the check itself failed: check again. */}
        <Button className="min-w-24" loading={pending} onClick={() => run(version ? install : check)}>
          {UPDATE_TEXT.retry}
        </Button>
      </>
    );
  } else {
    // Reached only after "Try again" found nothing newer, or while that check runs.
    body = (
      <Line>
        {update.state === "checking"
          ? UPDATE_TEXT.statusChecking
          : update.state === "disabled"
            ? UPDATE_TEXT.disabled
            : UPDATE_TEXT.statusUpToDate}
      </Line>
    );
    footer = (
      <>
        {update.state === "disabled" && (
          <InkLink className="mr-auto" onClick={openReleasesPage}>
            {UPDATE_TEXT.openReleases}
          </InkLink>
        )}
        <Button className="min-w-24" onClick={onClose}>
          {UPDATE_TEXT.close}
        </Button>
      </>
    );
  }

  return (
    <Modal variant="alert" open={open} onClose={onClose} dismissible={!busy} closeOnBackdrop={!busy} title={title} footer={footer}>
      {body}
    </Modal>
  );
}

export default UpdateDialog;
