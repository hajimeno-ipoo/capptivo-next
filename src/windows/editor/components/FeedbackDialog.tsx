/**
 * Feedback & contact dialog — opened from the editor title bar.
 * Links open in the system browser / mail client via plugin-opener.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { Bug, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/settings";
const ISSUES_URL = "https://github.com/hajimeno-ipoo/capptivo-next/issues";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function openExternal(url: string) {
  void openUrl(url).catch(() => undefined);
}

export function FeedbackDialog({ open, onOpenChange }: Props) {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 border-border bg-card p-5 sm:max-w-sm">
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary/15 text-primary">
              <Bug className="size-3.5" aria-hidden />
            </span>
            {t("feedback.title")}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {t("feedback.reportIssue")}
          </DialogDescription>
        </DialogHeader>

        <Button
          type="button"
          variant="outline"
          className="h-11 w-full justify-between gap-3 rounded-xl px-3.5"
          onClick={() => openExternal(ISSUES_URL)}
        >
          <span className="flex items-center gap-2.5">
            <Bug className="size-4 text-muted-foreground" aria-hidden />
            <span className="text-sm font-medium">{t("feedback.reportIssue")}</span>
          </span>
          <ExternalLink className="size-3.5 text-muted-foreground" aria-hidden />
        </Button>
      </DialogContent>
    </Dialog>
  );
}
