import cliProgress from "cli-progress";
import type { GenericFormatter, Options, Params } from "cli-progress";

export interface ProgressReporter {
  update(current: number, total?: number): void;
  checkpoint(label: string): void;
  complete(message: string): void;
}

type ProgressReporterOptions = {
  label?: string;
  valueFormatter?: (value: number) => string;
};

function isCI(): boolean {
  return !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRCLECI ||
    process.env.TRAVIS ||
    process.env.BUILDKITE ||
    process.env.DRONE ||
    !process.stderr.isTTY
  );
}
let activeBar: cliProgress.SingleBar | null = null;

function logLine(text: string): void {
  if (activeBar) {
    // Stop the bar, clear the line, log the text, and start again
    activeBar.stop();
    process.stdout.write(`\x1b[2K\r${text}\n`);
    // Note: re-starting the bar here is tricky because it resets time.
    // However, since we are doing clearOnComplete, we don't want to leave artifacts.
    // Actually, cli-progress SingleBar redraws on the next update().
    return;
  }
  process.stdout.write(`${text}\n`);
}

export const logger = {
  info: (text: string) => logLine(text),
  warn: (text: string) => logLine(`\x1b[33m${text}\x1b[0m`),
  error: (text: string) => logLine(`\x1b[31m${text}\x1b[0m`),
};

export function stopProgress(): void {
  if (activeBar) {
    activeBar.stop();
    activeBar = null;
  }
}

class InteractiveProgressReporter implements ProgressReporter {
  private bar: cliProgress.SingleBar | null = null;
  private current = 0;
  private total = 0;

  constructor(private readonly options: ProgressReporterOptions = {}) {}

  private createBar(): cliProgress.SingleBar {
    const formatter: GenericFormatter = (_options: Options, params: Params, payload: { label?: string; currentText?: string; totalText?: string }) => {
      const label = payload?.label ? `\x1b[36m${payload.label}\x1b[0m ` : "";
      const currentText = payload?.currentText ?? String(params.value);

      if (payload?.totalText === "?") {
        return `${label}\x1b[33m${currentText}\x1b[0m`;
      }

      const barOptions = { ..._options, barCompleteChar: '\u2588', barIncompleteChar: '\u2591' };
      const bar = cliProgress.Format.BarFormat(params.progress, barOptions);
      const percentage = Math.min(100, Math.max(0, Math.round(params.progress * 100)));
      const totalText = payload?.totalText ?? String(params.total);
      return `${label}\x1b[32m${bar}\x1b[0m ${percentage}% | \x1b[33m${currentText}/${totalText}\x1b[0m`;
    };

    return new cliProgress.SingleBar({
      clearOnComplete: true,
      hideCursor: true,
      format: formatter,
    }, cliProgress.Presets.shades_classic);
  }

  update(current: number, total?: number): void {
    this.current = current;

    if (total === undefined || total <= 0) {
      if (!this.bar) {
        this.bar = this.createBar();
        activeBar = this.bar;
        this.bar.start(100, 0, {
          label: this.options.label ?? "",
          currentText: this.formatValue(current),
          totalText: "?",
        });
      } else {
        this.bar.update(0, {
          label: this.options.label ?? "",
          currentText: this.formatValue(current),
          totalText: "?",
        });
      }
      return;
    }

    this.total = total;
    if (!this.bar) {
      this.bar = this.createBar();
      activeBar = this.bar;
      this.bar.start(total, current, {
        label: this.options.label ?? "",
        currentText: this.formatValue(current),
        totalText: this.formatValue(total),
      });
      return;
    }

    this.bar.setTotal(total);
    this.bar.update(current, {
      label: this.options.label ?? "",
      currentText: this.formatValue(current),
      totalText: this.formatValue(total),
    });
  }

  checkpoint(label: string): void {
    logLine(`  ✓ ${label}`);
  }

  complete(message: string): void {
    if (this.bar) {
      this.bar.update(this.total, {
        label: this.options.label ?? "",
        currentText: this.formatValue(this.total),
        totalText: this.formatValue(this.total),
      });
      this.bar.stop();
      this.bar = null;
      if (activeBar === this.bar) {
        activeBar = null;
      }
    }
    logLine(`  ✓ ${message}`);
  }

  private formatValue(value: number): string {
    if (this.options.valueFormatter) {
      return this.options.valueFormatter(value);
    }
    return String(value);
  }
}

class CiLineProgressReporter implements ProgressReporter {
  private lastLogAt = 0;

  constructor(private readonly options: ProgressReporterOptions = {}) {}

  update(current: number, total?: number): void {
    const now = Date.now();
    if (now - this.lastLogAt < 1000) {
      return;
    }

    if (total !== undefined && total > 0) {
      const pct = Math.min(100, Math.round((current / total) * 100));
      process.stdout.write(`[progress] ${this.options.label ? `${this.options.label} ` : ""}${pct}% (${this.formatValue(current)}/${this.formatValue(total)})\n`);
    } else {
      process.stdout.write(`[progress] ${this.options.label ? `${this.options.label}: ` : ""}${this.formatValue(current)}\n`);
    }

    this.lastLogAt = now;
  }

  checkpoint(label: string): void {
    process.stdout.write(`[checkpoint] ${label}\n`);
  }

  complete(message: string): void {
    process.stdout.write(`[complete] ${message}\n`);
  }

  private formatValue(value: number): string {
    if (this.options.valueFormatter) {
      return this.options.valueFormatter(value);
    }
    return String(value);
  }
}

/**
 * Silent/no-op reporter for testing or when progress is unwanted.
 */
class SilentProgressReporter implements ProgressReporter {
  update(): void {}
  checkpoint(): void {}
  complete(): void {}
}

/**
 * Factory: creates appropriate reporter based on environment.
 */
export function createProgressReporter(
  mode?: "auto" | "interactive" | "ci" | "silent",
  options: ProgressReporterOptions = {}
): ProgressReporter {
  const envMode = process.env.PROGRESS_MODE;
  if (envMode === "silent" || mode === "silent") {
    return new SilentProgressReporter();
  }

  if (envMode === "ci" || mode === "ci" || (mode !== "interactive" && isCI())) {
    return new CiLineProgressReporter(options);
  }

  return new InteractiveProgressReporter(options);
}
