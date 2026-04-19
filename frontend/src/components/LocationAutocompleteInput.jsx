import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps } from "../utils/googleMaps";

function LocationAutocompleteInput({
  value,
  onChange,
  placeholder,
  className = "input",
  disabled = false,
}) {
  const inputRef = useRef(null);
  const autocompleteRef = useRef(null);
  const listenerRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const [autocompleteError, setAutocompleteError] = useState("");

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let cancelled = false;

    loadGoogleMaps()
      .then((maps) => {
        if (cancelled || !inputRef.current || autocompleteRef.current) {
          return;
        }

        autocompleteRef.current = new maps.places.Autocomplete(inputRef.current, {
          fields: ["formatted_address", "name"],
          types: ["geocode"],
        });

        listenerRef.current = autocompleteRef.current.addListener("place_changed", () => {
          const place = autocompleteRef.current?.getPlace();
          const nextValue =
            place?.formatted_address || place?.name || inputRef.current?.value || "";
          onChangeRef.current(nextValue);
        });
      })
      .catch((error) => {
        if (!cancelled) {
          setAutocompleteError(error.message);
        }
      });

    return () => {
      cancelled = true;
      if (listenerRef.current) {
        listenerRef.current.remove();
      }
    };
  }, []);

  return (
    <>
      <input
        ref={inputRef}
        className={className}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        disabled={disabled}
      />
      {autocompleteError && <p className="helper-text error-text">{autocompleteError}</p>}
    </>
  );
}

export default LocationAutocompleteInput;
