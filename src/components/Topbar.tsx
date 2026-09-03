import { Menu } from "lucide-react";

interface TopbarProps {
  onMenu: () => void;
}

export function Topbar({ onMenu }: TopbarProps) {
  return (
    <header className="topbar topbar--menu-only">
      <button className="icon-button mobile-menu" aria-label="打开导航" title="打开导航" onClick={onMenu}><Menu size={19} /></button>
    </header>
  );
}
