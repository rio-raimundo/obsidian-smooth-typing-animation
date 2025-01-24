import { Plugin, MarkdownView, Editor, App, PluginSettingTab, Setting, ButtonComponent, ColorComponent, SliderComponent} from 'obsidian';
type Coordinates = { left: number; top: number};
type Position = { line: number; ch: number };
interface ExtendedEditor extends Editor { containerEl: HTMLElement; }
  
export default class SmoothTypingAnimation extends Plugin {
	settings: SmoothTypingSettings;
	cursorElement: HTMLSpanElement;
	isInWindow = true;

	prevCursorCoords: Coordinates = { left: 0, top: 0};  // measured in px
	prevCursorPos: Position | null = { line: 0, ch: 0 };  // measured in line and character
	prevIconCoords: Coordinates | null = { left: 0, top: 0 };  // coordinates of the visible 'icon' (not cursor itself)
	
	prevFrameTime: number = Date.now();
	blinkStartTime: number = Date.now();

	remainingMoveTime = 0;

	changeCursorColour(colour: string | null = null): void {
		if (colour === null) {
			const isLightTheme = document.body.classList.contains('theme-dark') ? false : true;
			colour = isLightTheme ? `#000000` : `#ffffff`
		}
		this.cursorElement.style.setProperty("--cursor-color", colour);
	}

	// Contains the architecture which will be called when the main function needs to return
	private scheduleNextUpdate() {
		requestAnimationFrame(this.updateCursor.bind(this));
	}

	//  Handles blinking of cursor and resets if it moves
	private blinkCursor(cursorPosChanged: boolean): number {
		const resetCursor = () => {
			requestAnimationFrame(() => { this.blinkStartTime = Date.now(); });
			return 1;
		}

		// Check if cursor position has changed
		if (cursorPosChanged) { return resetCursor(); }

		// Return an opacity of 1 for the first 'half' of the blink, then an opacity of 0 for the second half
		// Should be modular, and loop forever until cursor moves
		const timePassed = Date.now() - this.blinkStartTime - this.settings.blinkDelay*1000;
		const blinkMs = this.settings.blinkSpeed*1000;
		if (timePassed < 0) { return 1; }
		if (timePassed % blinkMs < blinkMs/2) { return 1; }
		else { return 0; }
	}

	// Handles smooth typing, and returns fraction of distance to travel this frame
	private handleSmoothTyping(currCursorPos: Position | null, currCursorCoords: Coordinates, timeSinceLastFrame: number): number {
		const returnStatement = (fractionTravelled = 0) => {
			if (fractionTravelled === 0) { this.remainingMoveTime = 0; }
			this.prevCursorPos = currCursorPos;
			return fractionTravelled;
		}

		// If current cursor position does not exist
		if (!currCursorPos || !this.prevCursorPos) { return returnStatement(); }
		
		const charIncremented = Math.abs(this.prevCursorPos.ch - currCursorPos.ch) === 1;
		const charMoved = Math.abs(this.prevCursorPos.ch - currCursorPos.ch) !== 0;
		const lineMoved = Math.abs(this.prevCursorPos.line - currCursorPos.line) !== 0;

		// If there has been a sharpMovement of the true cursor, we cancel the smooth movement of the icon
		if ((charMoved && !charIncremented) || (lineMoved)) {
			this.remainingMoveTime = 0;
		}

		// If there has been a smoothMovement of the true cursor, we add to the movement time remaining
		else if (charIncremented && !lineMoved) {
			// If line changed then we want a sharpMovement
			if (currCursorCoords.top !== this.prevCursorCoords.top) { this.remainingMoveTime = 0 }
			//  Else it's a true smoothMovement
			else { this.remainingMoveTime = this.settings.characterMovementTime; }
		}
		
		// Regardless of movement, we get the fraction of the total distance travelled (timeSinceLastFrame / remainingMovementTime)
		// and remove the timeSinceLastFrame from the remainingMovementTime
		if (this.remainingMoveTime <= 0) { return returnStatement(); }
		const fractionTravelled = Math.min(timeSinceLastFrame / this.remainingMoveTime, 1);
		this.remainingMoveTime = Math.max(0, this.remainingMoveTime - timeSinceLastFrame);

		// Update prevCursorPosition
		return returnStatement(fractionTravelled);
	} 

	private returnReferences(): { selection: Selection | null; editor: ExtendedEditor | null } {
		const selection = activeWindow.getSelection();
		const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor: ExtendedEditor | null = activeLeaf ? (activeLeaf.editor as ExtendedEditor) : null;
		return { selection, editor };
	}

	private getTimeSinceLastFrame(): number {
		const currentTime = Date.now();
		const timeSinceLastFrame = currentTime - this.prevFrameTime;
		this.prevFrameTime = currentTime;
		return timeSinceLastFrame;
	}

	private removeIcon() { this.cursorElement.style.display = 'none'; }
	private bringIconBack() { this.cursorElement.style.display = 'block'; }

	// Main function, called every frame
	updateCursor() {
		// Keep track of time on each frame, and how much has elapsed
		const timeSinceLastFrame = this.getTimeSinceLastFrame();

		// Get needed references and return if there is no selection
		const { selection, editor } = this.returnReferences();
		if (!selection || !selection.focusNode) { return this.scheduleNextUpdate(); }
		if (!editor || !editor.containerEl || !editor.containerEl.className.includes('cm-focused')) {  this.removeIcon(); return this.scheduleNextUpdate(); }
		else { this.bringIconBack(); }
		
		// If cursor position does not exist, we should also not render it
		const currCursorPos: Position = editor.getCursor();
		
		// Take the focused 'node', turn it into a range from start to finish
		const cursorRange = document.createRange();

		// Have to handle 0 as a special case so that the cursor shows up on empty lines, not sure why
		cursorRange.setStart(selection.focusNode, selection.focusOffset);
		if (selection.focusOffset === 0) { cursorRange.setEnd(selection.focusNode, 1); }
		else { cursorRange.setEnd(selection.focusNode, selection.focusOffset); }
		const currCursorCoords = cursorRange.getBoundingClientRect();

		// Check if cursor position has changed
		const cursorCoordinatesChanged = (this.prevCursorCoords.left !== currCursorCoords.left || this.prevCursorCoords.top !== currCursorCoords.top);

		// Calculate current cursor opacity 
		const blinkOpacity = this.blinkCursor(cursorCoordinatesChanged);

		// Get the fraction of total distance that the cursor icon should travel this frame
		// nonzero if currently smoothly moving
		// and turn it into a true distance
		const iconMovementFraction = this.handleSmoothTyping(currCursorPos, currCursorCoords, timeSinceLastFrame);
		let currIconCoords;
		if (iconMovementFraction !== 0 && this.prevIconCoords) {			
			const movementThisFrame: Coordinates = {
				left: iconMovementFraction * (currCursorCoords.left - this.prevIconCoords.left),
				top: iconMovementFraction * (currCursorCoords.top - this.prevIconCoords.top)
			};
			currIconCoords = {
				left: this.prevIconCoords.left + movementThisFrame.left,
				top: this.prevIconCoords.top + movementThisFrame.top
			};
		}
		else {
			currIconCoords = currCursorCoords;
		}

		// Send cursor details to .css to render
		if (currIconCoords) {
			this.cursorElement.style.setProperty("--cursor-x1", `${currIconCoords.left}px`);
			this.cursorElement.style.setProperty("--cursor-y1", `${currIconCoords.top}px`);
			this.cursorElement.style.setProperty("--cursor-height", `${currCursorCoords.height}px`);
			this.cursorElement.style.setProperty("--cursor-width", `${this.settings.cursorWidth}px`);
			this.cursorElement.style.setProperty("--cursor-opacity", `${blinkOpacity}`);
		}

		//  Update this.lastPos and recall
		this.prevCursorCoords = {
			left: currCursorCoords.left,
			top: currCursorCoords.top,
		}
		this.prevIconCoords = currIconCoords;

		// Schedule next update
		return this.scheduleNextUpdate();
	}

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SmoothTypingSettingsTab(this.app, this));

		// Create the cursor element, and apply the custom class cursor to it
		// Set the default cursor colour based on the theme
		this.cursorElement = document.body.createSpan({ cls: "custom-cursor", });
		this.changeCursorColour();  // resets if no arguments given

		// Initialise variables and schedule our first function call, which will be recalled once per frame.
		requestAnimationFrame(() => { this.blinkStartTime = Date.now(); });
		this.scheduleNextUpdate();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	
	async saveSettings() {
		await this.saveData(this.settings);
	}
}


// HANDLE SETTINGS
interface SmoothTypingSettings {
	blinkSpeed: number;
	blinkDelay: number;
	characterMovementTime: number;
	cursorWidth: number;
	cursorColor: string | null;
}
const DEFAULT_SETTINGS: SmoothTypingSettings = {
	blinkSpeed: 1.2,
	blinkDelay: 0,
	characterMovementTime: 80,
	cursorWidth: 1,
	cursorColor: '#ffffff',
};

export class SmoothTypingSettingsTab extends PluginSettingTab {
	plugin: SmoothTypingAnimation;
	
	constructor(app: App, plugin: SmoothTypingAnimation) {
		super(app, plugin);
		this.plugin = plugin;
	}


	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// CURSOR COLOUR SETTING
		const cursorColorSetting = new Setting(this.containerEl)
			.setName('Cursor colour')
			.setDesc('The colour of the cursor icon. Defaults to (dark-mode dependent) black or white.');
		new ResetButtonComponent(cursorColorSetting.controlEl).onClick(async () => {
			colorPicker.setValue('#ffffff');
			this.plugin.settings.cursorColor = null; // Custom saving to not save the color black in the data.
			this.plugin.changeCursorColour();
			await this.plugin.saveSettings();
		});
		const colorPicker = new ColorComponent(cursorColorSetting.controlEl)
			.setValue(this.plugin.settings.cursorColor ?? '#ffffff')
			.onChange(async (value) => {
				this.plugin.settings.cursorColor = value;
				this.plugin.changeCursorColour(value);
				await this.plugin.saveSettings();
		});

		// BLINK SPEED SLIDER
		const blinkSpeedSetting = new Setting(this.containerEl)
			.setName('Blink speed (in seconds)')
			.setDesc('The number of seconds to complete one full cursor blink cycle.')
		new ResetButtonComponent(blinkSpeedSetting.controlEl)
			.onClick(async () => {
				blinkSpeedSlider.setValue(DEFAULT_SETTINGS.blinkSpeed);
				await this.plugin.saveSettings();
			});
		const blinkSpeedSlider = new SliderComponent(blinkSpeedSetting.controlEl)
			.setLimits(0.2, 5, 0.1)
			.setDynamicTooltip()
			.setValue(this.plugin.settings.blinkSpeed ?? DEFAULT_SETTINGS.blinkSpeed)
			.onChange(async (val) => {
				this.plugin.settings.blinkSpeed = val; // convert to ms
				await this.plugin.saveSettings();
			});

		// BLINK DELAY SLIDER
		const blinkDelaySetting = new Setting(this.containerEl)
			.setName('Blink delay (in seconds)')
			.setDesc('The number of seconds after cursor movement before blinking begins.')
		new ResetButtonComponent(blinkDelaySetting.controlEl)
			.onClick(async () => {
				blinkDelaySlider.setValue(DEFAULT_SETTINGS.blinkDelay);
				await this.plugin.saveSettings();
			});
		const blinkDelaySlider = new SliderComponent(blinkDelaySetting.controlEl)	
			.setLimits(0, 5, 0.1)
			.setDynamicTooltip()
			.setValue( this.plugin.settings.blinkDelay ?? DEFAULT_SETTINGS.blinkDelay)
			.onChange(async (val) => {
				this.plugin.settings.blinkDelay = val;
				await this.plugin.saveSettings();
			});

		// SMOOTH TYPING SPEED SLIDER
		const smoothTypingSetting = new Setting(this.containerEl)
			.setName('Smooth typing speed (in milliseconds)')
			.setDesc('The number of milliseconds for the cursor icon to reach the true cursor location after typing or moving the cursor. 0 for instant speed.')
		new ResetButtonComponent(smoothTypingSetting.controlEl)
			.onClick(async () => {
				smoothTypingSpeedSlider.setValue(DEFAULT_SETTINGS.characterMovementTime);
				await this.plugin.saveSettings();
			});
		const smoothTypingSpeedSlider = new SliderComponent(smoothTypingSetting.controlEl)
			.setLimits(0, 200, 1)
			.setDynamicTooltip()
			.setValue(this.plugin.settings.characterMovementTime ?? DEFAULT_SETTINGS.blinkDelay)
			.onChange(async (val) => {
				this.plugin.settings.characterMovementTime = val;
				await this.plugin.saveSettings();
			});
		
		// CURSOR WIDTH SLIDER
		const cursorWidthSetting = new Setting(this.containerEl)
			.setName('Cursor width (in pixels)')
			.setDesc('The width of the cursor icon in pixels.')
		new ResetButtonComponent(cursorWidthSetting.controlEl)
			.onClick(async () => {
				cursorWidthSlider.setValue(DEFAULT_SETTINGS.cursorWidth);
				await this.plugin.saveSettings();	
			});
		const cursorWidthSlider = new SliderComponent(cursorWidthSetting.controlEl)
			.setLimits(1, 5, 1)
			.setDynamicTooltip()
			.setValue(this.plugin.settings.cursorWidth ?? DEFAULT_SETTINGS.cursorWidth)
			.onChange(async (val) => {
				this.plugin.settings.cursorWidth = val;
				await this.plugin.saveSettings();
			});
	}
}

class ResetButtonComponent extends ButtonComponent {
	constructor(protected contentEl: HTMLElement) {
		super(contentEl);
		this.setTooltip('Restore default');
		this.setIcon('rotate-ccw');
		this.render();
	}

	private render(): void {
		this.buttonEl.classList.add('clickable-icon');
		this.buttonEl.classList.add('extra-setting-button');
	}
}
