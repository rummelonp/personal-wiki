import { type FormEvent, useEffect, useState } from "react";
import { homeHref, navigate } from "./route";

interface SearchBoxProps {
  /** 現在の検索語。`/?q=` と入力欄をそろえる。 */
  query: string;
}

export function SearchBox({ query }: SearchBoxProps) {
  const [text, setText] = useState(query);

  useEffect(() => {
    setText(query);
  }, [query]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    navigate(homeHref(text));
  }

  return (
    <search className="search">
      <form onSubmit={handleSubmit}>
        <input
          className="search-input"
          type="search"
          aria-label="検索"
          placeholder="検索"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </form>
    </search>
  );
}
