// Minimal ambient types for the slice of the Cast Web Sender SDK and Safari's
// AirPlay API this app actually calls - not the full @types/chromecast-caf-sender
// surface, which pulls in a lot more than a single player component needs.

interface Window {
  __onGCastApiAvailable?: (isAvailable: boolean) => void;
  cast?: {
    framework: {
      CastContext: {
        getInstance(): CastContext;
      };
      CastContextEventType: {
        SESSION_STATE_CHANGED: string;
        CAST_STATE_CHANGED: string;
      };
      SessionState: {
        SESSION_STARTED: string;
        SESSION_RESUMED: string;
        SESSION_ENDED: string;
      };
      CastState: {
        NO_DEVICES_AVAILABLE: string;
      };
      RemotePlayer: new () => RemotePlayer;
      RemotePlayerController: new (player: RemotePlayer) => RemotePlayerController;
      RemotePlayerEventType: {
        IS_CONNECTED_CHANGED: string;
        IS_PAUSED_CHANGED: string;
        CURRENT_TIME_CHANGED: string;
        DURATION_CHANGED: string;
      };
    };
  };
  chrome?: {
    cast: {
      AutoJoinPolicy: { ORIGIN_SCOPED: string };
      media: {
        DEFAULT_MEDIA_RECEIVER_APP_ID: string;
        MediaInfo: new (contentId: string, contentType: string) => ChromeCastMediaInfo;
        GenericMediaMetadata: new () => ChromeCastMediaMetadata;
        LoadRequest: new (mediaInfo: ChromeCastMediaInfo) => ChromeCastLoadRequest;
      };
    };
  };
}

interface CastContext {
  setOptions(options: { receiverApplicationId: string; autoJoinPolicy: string }): void;
  addEventListener(
    type: string,
    handler: (event: { sessionState?: string; castState?: string }) => void
  ): void;
  removeEventListener(
    type: string,
    handler: (event: { sessionState?: string; castState?: string }) => void
  ): void;
  getCurrentSession(): CastSession | null;
  getCastState(): string;
  requestSession(): Promise<void>;
}

interface CastSession {
  loadMedia(request: ChromeCastLoadRequest): Promise<void>;
  getCastDevice(): { friendlyName: string };
  endSession(stopCasting: boolean): void;
}

interface ChromeCastMediaMetadata {
  title?: string;
  images?: { url: string }[];
}

interface ChromeCastMediaInfo {
  metadata?: ChromeCastMediaMetadata;
}

interface ChromeCastLoadRequest {
  currentTime?: number;
}

interface RemotePlayer {
  isConnected: boolean;
  isPaused: boolean;
  currentTime: number;
  duration: number;
}

interface RemotePlayerController {
  playOrPause(): void;
  seek(): void;
  addEventListener(type: string, handler: () => void): void;
  removeEventListener(type: string, handler: () => void): void;
}

interface HTMLVideoElement {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
}
