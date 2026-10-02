import { SignupForm } from "./components/SignupForm";
import { DateFilterList } from "./components/DateFilterList";
import { DelayedSection } from "./components/DelayedSection";

export function App() {
  return (
    <>
      <header className="app-header">
        <h1>pixel-commit playground</h1>
        <nav>
          <a href="#signup">Signup</a>
          <a href="#events">Events</a>
          <a href="#stats">Stats</a>
        </nav>
      </header>
      <main className="app-main">
        <SignupForm />
        <DateFilterList />
        <DelayedSection />
      </main>
    </>
  );
}
