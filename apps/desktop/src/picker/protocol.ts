/** What the picker window shows for each thing that can be captured. */
export interface PickerSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** PNG data URL. */
  thumbnail: string;
}

export const PICKER_SOURCES = 'picker:sources';
export const PICKER_CHOOSE = 'picker:choose';

/** The bridge the preload script exposes to the picker page. */
export interface PickerBridge {
  sources(): Promise<PickerSource[]>;
  /** `null` cancels. */
  choose(id: string | null): void;
}
