import { app, clipboard, dialog, screen, type BrowserWindow } from 'electron';

const VENDORS: Record<number, string> = {
  0x1002: 'AMD',
  0x10de: 'NVIDIA',
  0x8086: 'Intel',
  0x1414: 'Microsoft',
};

interface GpuDevice {
  active?: boolean;
  vendorId?: number;
  deviceId?: number;
  deviceString?: string;
  driverVersion?: string;
}

interface GpuInfo {
  gpuDevice?: GpuDevice[];
  auxAttributes?: { glRenderer?: string };
}

const hex = (value: number | undefined) =>
  value === undefined ? '?' : `0x${value.toString(16).padStart(4, '0')}`;

/** What the app runs on, as text a user can paste into a chat when a stream misbehaves. */
export async function describeSystem(): Promise<string> {
  const info = (await app.getGPUInfo('complete').catch(() => ({}))) as GpuInfo;
  const features = app.getGPUFeatureStatus() as unknown as Record<string, string>;
  const devices = (info.gpuDevice ?? []).map((device) => {
    const vendor =
      device.vendorId === undefined ? '?' : (VENDORS[device.vendorId] ?? hex(device.vendorId));
    const name = device.deviceString || hex(device.deviceId);
    const driver = device.driverVersion ? ` driver ${device.driverVersion}` : '';
    return `${device.active ? '* EM USO  ' : '  parada  '} ${vendor} ${name}${driver}`;
  });
  const displays = screen.getAllDisplays().map((display) => {
    const { width, height } = display.size;
    return `  ${width}x${height} escala ${display.scaleFactor} ${display.displayFrequency} Hz`;
  });
  return [
    `Dispeaker ${app.getVersion()} / Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
    'PLACAS DE VIDEO',
    ...(devices.length > 0 ? devices : ['  (nenhuma informada)']),
    `RENDERIZADOR ${info.auxAttributes?.glRenderer ?? '?'}`,
    'TELAS',
    ...displays,
    'RECURSOS',
    ...['gpu_compositing', 'video_decode', 'video_encode', 'webgl'].map(
      (key) => `  ${key}: ${features[key] ?? '?'}`,
    ),
  ].join('\n');
}

/** Shows the description and offers to copy it. */
export async function showDiagnostics(parent: BrowserWindow): Promise<void> {
  const text = await describeSystem();
  const { response } = await dialog.showMessageBox(parent, {
    type: 'info',
    title: 'Diagnóstico',
    message: 'Diagnóstico do Dispeaker',
    detail: text,
    buttons: ['Copiar', 'Fechar'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) clipboard.writeText(text);
}
