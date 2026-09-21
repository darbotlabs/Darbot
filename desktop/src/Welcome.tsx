const darbotIcon = new URL("../src-tauri/icons/128x128.png", import.meta.url)
  .href;

export function BrandLockup() {
  return (
    <div className="lockup">
      <img className="brand-mark" src={darbotIcon} alt="" />
      <span>darbot</span>
    </div>
  );
}

/**
 * What darbot is, before it asks for anything.
 *
 * Few words on purpose. The person here was sent a link by their IT department and has not decided
 * to care yet: they need to know what this is, that it will not ask them for anything technical,
 * and where the button is. Everything else waits for a screen that needs it.
 */
export function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="sheet">
      <BrandLockup />
      <h1>Your own AI coworkers, on this computer.</h1>
      <p className="lede big">
        They answer questions, use the tools you connect, and can work in a
        browser for you.
      </p>
      <div className="row">
        <button type="button" onClick={onStart}>
          Set up darbot
        </button>
      </div>
      <p className="footnote">
        Takes a few minutes. darbot installs what it needs and asks you to sign
        in to the AI plan you already have.
      </p>
    </div>
  );
}
