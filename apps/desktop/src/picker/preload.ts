import { contextBridge, ipcRenderer } from 'electron';
import { PICKER_CHOOSE, PICKER_SOURCES, type PickerBridge, type PickerSource } from './protocol';

const bridge: PickerBridge = {
  sources: () => ipcRenderer.invoke(PICKER_SOURCES) as Promise<PickerSource[]>,
  choose: (id) => ipcRenderer.send(PICKER_CHOOSE, id),
};

contextBridge.exposeInMainWorld('picker', bridge);
