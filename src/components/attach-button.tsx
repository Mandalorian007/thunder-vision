"use client";

import { Paperclip } from "lucide-react";
import { useRef } from "react";
import { IconButton } from "@/components/icon-button";

/** The paperclip: pick files to upload to the Mac and type the paths of. */
export function AttachButton({ onAttach }: { onAttach(files: File[]): void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onAttach(files);
        }}
      />
      <IconButton
        label="Attach a file (uploads it and types its path)"
        onClick={() => fileRef.current?.click()}
      >
        <Paperclip />
      </IconButton>
    </>
  );
}
