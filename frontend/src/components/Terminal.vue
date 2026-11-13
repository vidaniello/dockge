<template>
    <div class="shadow-box">
        <div v-pre ref="terminal" class="main-terminal"></div>
    </div>
</template>

<script>
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TERMINAL_COLS, TERMINAL_ROWS } from "../../../common/util-common";
import { copyToClipboard } from "../util-frontend";

export default {
    /**
     * @type {Terminal}
     */
    terminal: null,
    components: {

    },
    props: {
        name: {
            type: String,
            required: true,
        },

        endpoint: {
            type: String,
            required: true,
        },

        // Require if mode is interactive
        stackName: {
            type: String,
            default: "",
        },

        // Require if mode is interactive
        serviceName: {
            type: String,
            default: "",
        },

        // Require if mode is interactive
        shell: {
            type: String,
            default: "bash",
        },

        rows: {
            type: Number,
            default: TERMINAL_ROWS,
        },

        cols: {
            type: Number,
            default: TERMINAL_COLS,
        },

        // Mode
        // displayOnly: Only display terminal output
        // mainTerminal: Allow input limited commands and output
        // interactive: Free input and output
        mode: {
            type: String,
            default: "displayOnly",
        }
    },
    emits: [ "has-data" ],
    data() {
        return {
            first: true,
            terminalInputBuffer: "",
            cursorPosition: 0,
        };
    },
    computed: {
        hasInput() {
            return this.mode === "mainTerminal" || this.mode === "interactive";
        },
    },
    created() {

    },
    mounted() {
        this.terminal = new Terminal({
            fontSize: 14,
            fontFamily: "'JetBrains Mono', monospace",
            cursorBlink: this.hasInput,
            cols: this.cols,
            rows: this.rows,
            scrollback: this.hasInput ? 5000 : 10000,
            // Allow selecting text with the mouse even if the program in the container enabled mouse events (e.g. htop)
            macOptionClickForcesSelection: true,
        });

        // Copy / paste keyboard shortcuts.
        // Returning false lets the browser run its native copy/paste action. xterm.js then fills the
        // clipboard from the "copy" event and reads it from the "paste" event. Unlike navigator.clipboard,
        // this also works when Dockge is served over plain HTTP (e.g. http://truenas.local:5001).
        this.terminal.attachCustomKeyEventHandler(this.handleCustomKeyEvent);

        if (this.mode === "mainTerminal") {
            this.mainTerminalConfig();
        } else if (this.mode === "interactive") {
            this.interactiveTerminalConfig();
        }

        // Bind to a div
        this.terminal.open(this.$refs.terminal);

        if (this.hasInput) {
            this.terminal.focus();
        }

        // In mainTerminal mode, input is line-buffered on the client side, so pasted text must be inserted into the buffer
        this.$refs.terminal.addEventListener("paste", this.handlePasteEvent, true);

        // Copy on select (like PuTTY / most Linux terminals)
        this.$refs.terminal.addEventListener("mouseup", this.handleMouseUp);

        // Notify parent component when data is received
        this.terminal.onCursorMove(() => {
            if (this.first) {
                this.$emit("has-data");
                this.first = false;
            }
        });

        this.bind();

        // Create a new Terminal
        if (this.mode === "mainTerminal") {
            this.$root.emitAgent(this.endpoint, "mainTerminal", this.name, (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                } else {
                    this.syncSizeToServer(true);
                }
            });
        } else if (this.mode === "interactive") {
            console.debug("Create Interactive terminal:", this.name);
            this.$root.emitAgent(this.endpoint, "interactiveTerminal", this.stackName, this.serviceName, this.shell, (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                } else {
                    this.syncSizeToServer(true);
                }
            });
        }

        // Fit the terminal to its container, and refit whenever the container changes size
        // (window resize, drag-resize, fullscreen toggle...)
        this.terminalFitAddOn = new FitAddon();
        this.terminal.loadAddon(this.terminalFitAddOn);
        this.fit();

        this.resizeObserver = new ResizeObserver(() => {
            clearTimeout(this.resizeTimeout);
            this.resizeTimeout = setTimeout(() => {
                this.fit();
                this.syncSizeToServer();
            }, 50);
        });
        this.resizeObserver.observe(this.$refs.terminal);
    },

    unmounted() {
        clearTimeout(this.resizeTimeout);
        this.resizeObserver?.disconnect();
        this.$root.unbindTerminal(this.name);
        this.terminal.dispose();
        this.$refs.terminal?.removeEventListener("paste", this.handlePasteEvent, true);
        this.$refs.terminal?.removeEventListener("mouseup", this.handleMouseUp);
    },

    methods: {
        bind(endpoint, name) {
            // Workaround: normally this.name should be set, but it is not sometimes, so we use the parameter, but eventually this.name and name must be the same name
            if (name) {
                this.$root.unbindTerminal(name);
                this.$root.bindTerminal(endpoint, name, this.terminal);
                console.debug("Terminal bound via parameter: " + name);
            } else if (this.name) {
                this.$root.unbindTerminal(this.name);
                this.$root.bindTerminal(this.endpoint, this.name, this.terminal);
                console.debug("Terminal bound: " + this.name);
            } else {
                console.debug("Terminal name not set");
            }
        },

        removeInput() {
            const textAfterCursorLength = this.terminalInputBuffer.length - this.cursorPosition;
            const spaces = " ".repeat(textAfterCursorLength);
            const backspaceCount = this.terminalInputBuffer.length;
            const backspaces = "\b \b".repeat(backspaceCount);
            this.cursorPosition = 0;
            this.terminal.write(spaces + backspaces);
            this.terminalInputBuffer = "";
        },

        clearCurrentLine() {
            // Move cursor to the beginning of the input and clear it
            const backspaces = "\b".repeat(this.cursorPosition);
            const spaces = " ".repeat(this.terminalInputBuffer.length);
            const moreBackspaces = "\b".repeat(this.terminalInputBuffer.length);
            this.terminal.write(backspaces + spaces + moreBackspaces);
        },

        mainTerminalConfig() {
            this.terminal.onKey(e => {
                // Optional: keep for debugging
                // console.debug("Encode: " + JSON.stringify(e.key));

                if (e.key === "\r") {
                    // Return if no input
                    if (this.terminalInputBuffer.length === 0) {
                        return;
                    }

                    const buffer = this.terminalInputBuffer;

                    // Remove the input from the terminal
                    this.removeInput();

                    this.$root.emitAgent(this.endpoint, "terminalInput", this.name, buffer + e.key, (err) => {
                        this.$root.toastError(err.msg);
                    });
                } else if (e.key === "\u007F") {      // Backspace
                    if (this.cursorPosition > 0) {
                        // Remove character to the left of cursor
                        const beforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition - 1);
                        const afterCursor = this.terminalInputBuffer.slice(this.cursorPosition);
                        this.terminalInputBuffer = beforeCursor + afterCursor;
                        this.cursorPosition--;

                        // Redraw the line
                        this.terminal.write("\b" + afterCursor + " \b".repeat(afterCursor.length + 1));
                    }
                } else if (e.key === "\u001B[3~") { // Delete key
                    if (this.cursorPosition < this.terminalInputBuffer.length) {
                        // Remove character to the right of cursor
                        const beforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition);
                        const afterCursor = this.terminalInputBuffer.slice(this.cursorPosition + 1);
                        this.terminalInputBuffer = beforeCursor + afterCursor;

                        // Redraw the line from cursor position
                        this.terminal.write(afterCursor + " \b".repeat(afterCursor.length + 1));
                    }
                } else if (e.key === "\u001B[A" || e.key === "\u001B[B") {      // UP OR DOWN
                    // Do nothing
                } else if (e.key === "\u001B[C") {      // RIGHT
                    if (this.cursorPosition < this.terminalInputBuffer.length) {
                        this.terminal.write(this.terminalInputBuffer[this.cursorPosition]);
                        this.cursorPosition++;
                    }
                } else if (e.key === "\u001B[D") {      // LEFT
                    if (this.cursorPosition > 0) {
                        this.terminal.write("\b");
                        this.cursorPosition--;
                    }
                } else if (e.key === "\u0003") {      // Ctrl + C
                    console.debug("Ctrl + C");
                    this.$root.emitAgent(this.endpoint, "terminalInput", this.name, e.key);
                    this.removeInput();
                } else if (e.key === "\u0009" || e.key.startsWith("\u001B") || (e.key.length === 1 && e.key < " ")) {
                    // TAB, escape sequences and other control characters: do nothing
                } else {
                    const textBeforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition);
                    const textAfterCursor = this.terminalInputBuffer.slice(this.cursorPosition);
                    this.terminalInputBuffer = textBeforeCursor + e.key + textAfterCursor;
                    this.terminal.write(e.key + textAfterCursor + "\b".repeat(textAfterCursor.length));
                    this.cursorPosition++;
                }
            });
        },

        interactiveTerminalConfig() {
            // onData (not onKey) receives keystrokes AND pasted text (including bracketed paste)
            this.terminal.onData((data) => {
                this.$root.emitAgent(this.endpoint, "terminalInput", this.name, data, (res) => {
                    if (!res.ok) {
                        this.$root.toastRes(res);
                    }
                });
            });
        },

        /**
         * Keyboard shortcuts for copy/paste.
         * - Ctrl+Shift+C, or Ctrl+C while some text is selected: copy (Ctrl+C without selection is still SIGINT)
         * - Ctrl+V, Ctrl+Shift+V, Shift+Insert: paste
         * @param {KeyboardEvent} e Keyboard event
         * @returns {boolean} false to let the browser handle the event natively
         */
        handleCustomKeyEvent(e) {
            if (e.type !== "keydown") {
                return true;
            }

            const key = e.key.toLowerCase();
            const ctrl = e.ctrlKey || e.metaKey;

            // Copy (done by hand: Ctrl+Shift+C is not a native copy shortcut, in Chrome it opens the DevTools)
            if (ctrl && key === "c" && (e.shiftKey || this.terminal.hasSelection())) {
                e.preventDefault();
                copyToClipboard(this.terminal.getSelection());
                if (!e.shiftKey) {
                    // Like Windows Terminal: after Ctrl+C copied the selection, the next Ctrl+C is SIGINT again
                    this.terminal.clearSelection();
                }
                if (this.hasInput) {
                    this.terminal.focus();
                }
                return false;
            }

            // Paste
            if (this.hasInput && ((ctrl && key === "v") || (e.shiftKey && key === "insert"))) {
                return false;
            }

            return true;
        },

        /**
         * Paste in mainTerminal mode: the text must go into the local line buffer instead of being sent directly.
         * In interactive mode xterm.js handles the paste event itself and forwards the text via onData.
         * @param {ClipboardEvent} event Paste event
         * @returns {void}
         */
        handlePasteEvent(event) {
            if (this.mode !== "mainTerminal") {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            const text = event.clipboardData?.getData("text/plain");
            if (text) {
                this.pasteText(text.replace(/\r?\n/g, " "));
            }
        },

        /**
         * Copy the selected text when the mouse button is released
         * @returns {void}
         */
        handleMouseUp() {
            if (this.terminal.hasSelection()) {
                copyToClipboard(this.terminal.getSelection());
                // Keep the keyboard focus in the terminal after the fallback copy
                if (this.hasInput) {
                    this.terminal.focus();
                }
            }
        },

        fit() {
            try {
                this.terminalFitAddOn?.fit();
            } catch (e) {
                // The element can be hidden (e.g. v-show), ignore
            }
        },

        /**
         * Tell the server the new size so that the remote program (shell, htop, vim...) wraps lines correctly
         * @param {boolean} force Send even if the size did not change
         * @returns {void}
         */
        syncSizeToServer(force = false) {
            const rows = this.terminal.rows;
            const cols = this.terminal.cols;

            if (!force && this.lastRows === rows && this.lastCols === cols) {
                return;
            }

            this.lastRows = rows;
            this.lastCols = cols;
            this.$root.emitAgent(this.endpoint, "terminalResize", this.name, rows, cols);
        },

        /**
         * Paste text into the terminal based on current mode
         * @param {string} text Text to paste
         * @returns {void}
         */
        pasteText(text) {
            if (this.mode === "mainTerminal") {
                // For main terminal, insert text at current cursor position
                const beforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition);
                const afterCursor = this.terminalInputBuffer.slice(this.cursorPosition);

                // Clear the current line and rewrite it
                this.clearCurrentLine();

                // Update the buffer with inserted text
                this.terminalInputBuffer = beforeCursor + text + afterCursor;
                this.terminal.write(this.terminalInputBuffer);

                // Move cursor to the correct position (after the pasted text)
                this.cursorPosition += text.length;
                const backspaces = "\b".repeat(afterCursor.length);
                this.terminal.write(backspaces);

            } else if (this.mode === "interactive") {
                this.terminal.paste(text);
            }
        },
    }
};
</script>

<style scoped lang="scss">
.main-terminal {
    height: 100%;
}
</style>

<style lang="scss">
.terminal {
    background-color: black !important;
    height: 100%;
}
</style>
