export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export interface ProfileParameter {
  category: string;
  name: string;
  value: string;
}

export interface ObsPreset {
  id: string;
  displayName: string;
  description: string;
  parameters: ProfileParameter[];
  video: {
    baseWidth: number;
    baseHeight: number;
    outputWidth: number;
    outputHeight: number;
    fpsNumerator: number;
    fpsDenominator: number;
  };
  encoderPolicy: {
    mode?: "standard" | "ffmpeg";
    acceptedEncoderIds: string[];
    container: string;
    rateControl?: string;
    cqpMaximum?: number;
    keyframeSeconds?: number;
    multipass?: string;
    bitrateMinimum?: number;
    audioEncoder?: string;
    audioMixes?: number;
  };
  expectedProbe: {
    codec: string;
    width: number;
    height: number;
    fps: number;
    bitDepth: number;
    colorRange: string;
    colorSpace: string;
    colorTransfer: string;
    colorPrimaries: string;
  };
}

export interface ProfileSnapshot extends JsonObject {
  kind: "legends-obs-profile-snapshot";
  version: 1;
  capturedAt: string;
  profileName: string;
  videoSettings: JsonObject;
  parameters: JsonObject;
  encoderSettings: JsonObject | null;
}
