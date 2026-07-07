import { useEffect } from 'react';
import { useStore } from './store';
import { initKeymap } from './keymap';
import { MenuBar } from './components/MenuBar';
import { OptionsBar } from './components/OptionsBar';
import { ToolRail } from './components/ToolRail';
import { CanvasView } from './components/CanvasView';
import { RightDock } from './components/RightDock';
import { StatusBar } from './components/StatusBar';
import { NewDocDialog, FillDialog, ShortcutsModal } from './components/Dialogs';
import { ExportDialog } from './components/ExportDialog';

export default function App() {
  const modal = useStore((s) => s.modal);
  const screenMode = useStore((s) => s.screenMode);
  const panelsHidden = useStore((s) => s.panelsHidden);

  useEffect(() => initKeymap(), []);

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
    </div>
  );
}
