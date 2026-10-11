import { useEffect } from 'react';
import { useStore } from './store';
import { initKeymap } from './keymap';
import { MenuBar } from './components/MenuBar';
import { OptionsBar } from './components/OptionsBar';
import { ToolRail } from './components/ToolRail';
import { CanvasView } from './components/CanvasView';
import { RightDock } from './components/RightDock';
import { StatusBar } from './components/StatusBar';
import { NewDocDialog, FillDialog, ShortcutsModal, ImageSizeDialog, CanvasSizeDialog, RemoveBgDialog } from './components/Dialogs';
import { ExportDialog } from './components/ExportDialog';

export default function App() {
  const modal = useStore((s) => s.modal);
  const screenMode = useStore((s) => s.screenMode);
  const panelsHidden = useStore((s) => s.panelsHidden);

  const hasDoc = useStore((s) => !!s.doc);

  useEffect(() => initKeymap(), []);

  // a file dropped anywhere outside a drop target must not navigate the tab away
  useEffect(() => {
    const block = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  return (
    <div className={`app screen-${screenMode} ${panelsHidden ? 'panels-hidden' : ''}`}>
      <MenuBar />
      <OptionsBar />
      <div className="main">
        <ToolRail />
        <CanvasView />
        <RightDock />
      </div>
      <StatusBar />
      {modal === 'newdoc' && <NewDocDialog />}
      {modal === 'fill' && <FillDialog />}
      {modal === 'shortcuts' && <ShortcutsModal />}
      {modal === 'export' && <ExportDialog />}
      {modal === 'imagesize' && hasDoc && <ImageSizeDialog />}
      {modal === 'canvassize' && hasDoc && <CanvasSizeDialog />}
      {modal === 'removebg' && hasDoc && <RemoveBgDialog />}
    </div>
  );
}
