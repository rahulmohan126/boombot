declare module 'pino-roll' {
  import type { SonicBoom } from 'sonic-boom';

  interface PinoRollOptions {
    file: string | (() => string);
    size?: number | string;
    frequency?: number | string;
    extension?: string;
    dateFormat?: string;
    mkdir?: boolean;
    symlink?: boolean;
    limit?: { count?: number; removeOtherLogFiles?: boolean };
  }

  export default function pinoRoll(options: PinoRollOptions): Promise<SonicBoom>;
}
