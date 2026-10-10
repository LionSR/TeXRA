import{a as e,c as t,d as n,f as r,i,o as a,r as o}from"./chunk.AOKMSJXD.CwVty8ct.js";import{a as s,i as c,n as l,t as u}from"./if-defined.D65f-FiP.js";import{t as d}from"./chunk.RPQJAXXR.DTRnLK1d.js";import{t as f}from"./chunk.G5ZZIGWB.DIDSjj64.js";import{t as p}from"./chunk.PZAN6FPN.CukSyESI.js";import{a as m,i as h,n as g,r as _,t as v}from"./class-map.BiAPlscz.js";import{n as y,r as b}from"./directive-helpers.BAHwZi2D.js";import{t as x}from"./chunk.56IHH3HP.Qx3La9Lx.js";var S=n`
  :host {
    --height: var(--wa-form-control-toggle-size);
    --width: calc(var(--height) * 1.75);
    --thumb-size: 0.75em;

    display: inline-flex;
    line-height: var(--wa-form-control-value-line-height);
  }

  label {
    position: relative;
    display: flex;
    align-items: center;
    font: inherit;
    color: var(--wa-form-control-value-color);
    vertical-align: middle;
    cursor: pointer;
  }

  .switch {
    flex: 0 0 auto;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--width);
    height: var(--height);
    background-color: var(--wa-form-control-background-color);
    border-color: var(--wa-form-control-border-color);
    border-radius: var(--height);
    border-style: var(--wa-form-control-border-style);
    border-width: var(--wa-form-control-border-width);
    transition-property: translate, background, border-color, box-shadow;
    transition-duration: var(--wa-transition-normal);
    transition-timing-function: var(--wa-transition-easing);
  }

  :host([did-ssr]:not(:defined)) .switch {
    transition-property: unset;
    transition-duration: unset;
    transition-timing-function: unset;
  }

  .switch .thumb {
    aspect-ratio: 1 / 1;
    width: var(--thumb-size);
    height: var(--thumb-size);
    background-color: var(--wa-form-control-border-color);
    border-radius: 50%;
    translate: calc((var(--width) - var(--height)) / -2);
    transition: inherit;
  }
  .switch .thumb:dir(rtl) {
    translate: calc((var(--width) - var(--height)) / 2);
  }

  .input {
    position: absolute;
    opacity: 0;
    padding: 0;
    margin: 0;
    pointer-events: none;
  }

  /* Focus */
  label:not(.disabled) .input:focus-visible ~ .switch .thumb {
    outline: var(--wa-focus-ring);
    outline-offset: var(--wa-focus-ring-offset);
  }

  /* Checked */
  .checked .switch {
    background-color: var(--wa-form-control-activated-color);
    border-color: var(--wa-form-control-activated-color);
  }

  .checked .switch .thumb {
    background-color: var(--wa-color-surface-default);
    translate: calc((var(--width) - var(--height)) / 2);
  }
  .checked .switch .thumb:dir(rtl) {
    translate: calc((var(--width) - var(--height)) / -2);
  }

  /* Disabled */
  label:has(> :disabled) {
    opacity: 0.5;
    cursor: not-allowed;
  }

  [part~='label'] {
    display: inline-block;
    line-height: var(--height);
    margin-inline-start: 0.5em;
    user-select: none;
    -webkit-user-select: none;
  }

  :host([required]) [part~='label']::after {
    content: var(--wa-form-control-required-content);
    color: var(--wa-form-control-required-content-color);
    margin-inline-start: var(--wa-form-control-required-content-offset);
  }

  @media (forced-colors: active) {
    :checked:enabled + .switch:hover .thumb,
    :checked + .switch .thumb {
      background-color: ButtonText;
    }
  }
`,C=n`
  :host {
    display: flex;
    flex-direction: column;
  }

  /* Treat wrapped labels, inputs, and hints as direct children of the host element */
  [part~='form-control'] {
    display: contents;
  }

  /* Label */
  :is([part~='form-control-label'], [part~='label']):has(*:not(:empty)),
  :is([part~='form-control-label'], [part~='label']).has-label {
    display: inline-flex;
    color: var(--wa-form-control-label-color);
    font-weight: var(--wa-form-control-label-font-weight);
    line-height: var(--wa-form-control-label-line-height);
    margin-block-end: 0.5em;
  }

  :host([required]) :is([part~='form-control-label'], [part~='label'])::after {
    content: var(--wa-form-control-required-content);
    margin-inline-start: var(--wa-form-control-required-content-offset);
    color: var(--wa-form-control-required-content-color);
  }

  /* Help text */
  [part~='hint'] {
    display: block;
    color: var(--wa-form-control-hint-color);
    font-weight: var(--wa-form-control-hint-font-weight);
    line-height: var(--wa-form-control-hint-line-height);
    margin-block-start: 0.5em;
    font-size: var(--wa-font-size-smaller);

    &:not(.has-slotted, .has-hint) {
      display: none;
    }
  }
`,w=g(class extends _{constructor(e){if(super(e),e.type!==h.PROPERTY&&e.type!==h.ATTRIBUTE&&e.type!==h.BOOLEAN_ATTRIBUTE)throw Error("The `live` directive is not allowed on child or event bindings");if(!b(e))throw Error("`live` bindings can only contain a single expression")}render(e){return e}update(t,[n]){if(n===a||n===e)return n;let r=t.element,i=t.name;if(t.type===h.PROPERTY){if(n===r[i])return a}else if(t.type===h.BOOLEAN_ATTRIBUTE){if(!!n===r.hasAttribute(i))return a}else if(t.type===h.ATTRIBUTE&&r.getAttribute(i)===n+``)return a;return y(t),n}}),T=class extends l{constructor(){super(...arguments),this.hasSlotController=new m(this,`hint`),this.localize=new x(this),this.title=``,this.name=null,this._value=this.getAttribute(`value`)??null,this.size=`m`,this.disabled=!1,this._checked=null,this.defaultChecked=this.hasAttribute(`checked`),this.required=!1,this.hint=``,this.withHint=!1}static get validators(){return[...super.validators,c()]}get value(){return this._value??`on`}set value(e){this._value=e}handleSizeChange(){d(this.localName,this.size)}get checked(){return this.valueHasChanged?!!this._checked:this._checked??this.defaultChecked}set checked(e){this._checked=!!e,this.valueHasChanged=!0}handleClick(){this.hasInteracted=!0,this.checked=!this.checked,this.updateComplete.then(()=>{this.dispatchEvent(new Event(`change`,{bubbles:!0,composed:!0}))})}handleKeyDown(e){let t=this.localize.dir()===`rtl`;e.key===`ArrowLeft`&&(e.preventDefault(),this.checked=t,this.updateComplete.then(()=>{this.dispatchEvent(new Event(`change`,{bubbles:!0,composed:!0})),this.dispatchEvent(new InputEvent(`input`,{bubbles:!0,composed:!0}))})),e.key===`ArrowRight`&&(e.preventDefault(),this.checked=!t,this.updateComplete.then(()=>{this.dispatchEvent(new Event(`change`,{bubbles:!0,composed:!0})),this.dispatchEvent(new InputEvent(`input`,{bubbles:!0,composed:!0}))}))}willUpdate(e){super.willUpdate(e),(e.has(`value`)||e.has(`checked`)||e.has(`defaultChecked`)||e.has(`disabled`))&&this.handleValueOrCheckedChange()}handleValueOrCheckedChange(){if(this.didSSR&&!this.hasUpdated){this.updateComplete.then(()=>{this.handleValueOrCheckedChange()});return}this.setValue(this.checked?this.value:null,this._value),this.updateValidity()}handleStateChange(){this.hasUpdated&&(this.input.checked=this.checked),this.customStates.set(`checked`,this.checked),this.updateValidity()}handleDisabledChange(){this.updateValidity()}click(){this.input.click()}focus(e){this.input.focus(e)}blur(){this.input.blur()}setValue(e,t){if(!this.checked){this.internals.setFormValue(null,null);return}this.internals.setFormValue(e??`on`,t)}formResetCallback(){this._checked=null,super.formResetCallback(),this.handleValueOrCheckedChange()}render(){let e=this.hasSlotController.test(`hint`,`withHint`),n=this.hint?!0:!!e,r=this.didSSR&&!this.hasUpdated?this.checked:this.defaultChecked,i=this.didSSR&&!this.hasUpdated?null:w(this.checked);return t`
      <label
        part="base switch"
        class=${v({checked:this.checked,disabled:this.disabled})}
      >
        <input
          class="input"
          type="checkbox"
          title=${this.title}
          name=${u(this.name)}
          value=${u(this.value)}
          .checked=${u(i)}
          ?checked=${r}
          ?disabled=${this.disabled}
          ?required=${this.required}
          role="switch"
          aria-checked=${this.checked?`true`:`false`}
          aria-describedby="hint"
          @click=${this.handleClick}
          @keydown=${this.handleKeyDown}
        />

        <span part="control" class="switch">
          <span part="thumb" class="thumb"></span>
        </span>

        <slot part="label" class="label"></slot>
      </label>

      <slot
        id="hint"
        name="hint"
        part="hint"
        class=${v({"has-slotted":n})}
        aria-hidden=${n?`false`:`true`}
        >${this.hint}</slot
      >
    `}};T.shadowRootOptions={...l.shadowRootOptions,delegatesFocus:!0},T.css=[C,f,S],r([s(`input[type="checkbox"]`)],T.prototype,`input`,2),r([o()],T.prototype,`title`,2),r([o({reflect:!0})],T.prototype,`name`,2),r([o({reflect:!0})],T.prototype,`value`,1),r([o({reflect:!0})],T.prototype,`size`,2),r([p(`size`)],T.prototype,`handleSizeChange`,1),r([o({type:Boolean})],T.prototype,`disabled`,2),r([o({type:Boolean,attribute:!1})],T.prototype,`checked`,1),r([o({type:Boolean,attribute:`checked`,reflect:!0})],T.prototype,`defaultChecked`,2),r([o({type:Boolean,reflect:!0})],T.prototype,`required`,2),r([o({attribute:`hint`})],T.prototype,`hint`,2),r([o({attribute:`with-hint`,type:Boolean})],T.prototype,`withHint`,2),r([p([`checked`,`defaultChecked`])],T.prototype,`handleStateChange`,1),r([p(`disabled`,{waitUntilFirstUpdate:!0})],T.prototype,`handleDisabledChange`,1),T=r([i(`wa-switch`)],T),T.disableWarning?.(`change-in-update`);export{T as default};