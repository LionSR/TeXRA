import{c as e,d as t,f as n,i as r,r as i,t as a}from"./chunk.AOKMSJXD.CwVty8ct.js";import{t as o}from"./chunk.XNTP7DEQ.DP_Un6RV.js";import{t as s}from"./chunk.RPQJAXXR.DTRnLK1d.js";import{t as c}from"./chunk.G5ZZIGWB.DIDSjj64.js";import{t as l}from"./chunk.PZAN6FPN.CukSyESI.js";var u=t`
  :host {
    display: flex;
    position: relative;
    align-items: stretch;
    border-radius: var(--wa-panel-border-radius);
    background-color: var(--wa-color-fill-quiet, var(--wa-color-brand-fill-quiet));
    border-color: var(--wa-color-border-quiet, var(--wa-color-brand-border-quiet));
    border-style: var(--wa-panel-border-style);
    border-width: var(--wa-panel-border-width);
    color: var(--wa-color-text-normal);
    padding: 1em;
  }

  /* Appearance modifiers */
  :host([appearance~='plain']) {
    background-color: transparent;
    border-color: transparent;
  }

  :host([appearance~='outlined']) {
    background-color: transparent;
    border-color: var(--wa-color-border-loud, var(--wa-color-brand-border-loud));
  }

  :host([appearance~='filled']) {
    background-color: var(--wa-color-fill-quiet, var(--wa-color-brand-fill-quiet));
    border-color: transparent;
  }

  :host([appearance~='filled-outlined']) {
    border-color: var(--wa-color-border-quiet, var(--wa-color-brand-border-quiet));
  }

  :host([appearance~='accent']) {
    color: var(--wa-color-on-loud, var(--wa-color-brand-on-loud));
    background-color: var(--wa-color-fill-loud, var(--wa-color-brand-fill-loud));
    border-color: transparent;

    [part~='icon'] {
      color: currentColor;
    }
  }

  [part~='icon'] {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    color: var(--wa-color-on-quiet);
    font-size: 1.25em;
  }

  ::slotted([slot='icon']) {
    margin-inline-end: var(--wa-form-control-padding-inline);
  }

  [part~='message'] {
    flex: 1 1 auto;
    display: block;
    overflow: hidden;
  }
`,d=class extends a{constructor(){super(...arguments),this.variant=`brand`,this.size=`m`}handleSizeChange(){s(this.localName,this.size)}render(){return e`
      <div part="icon">
        <slot name="icon"></slot>
      </div>

      <div part="message">
        <slot></slot>
      </div>
    `}};d.css=[u,o,c],n([i({reflect:!0})],d.prototype,`variant`,2),n([i({reflect:!0})],d.prototype,`appearance`,2),n([i({reflect:!0})],d.prototype,`size`,2),n([l(`size`)],d.prototype,`handleSizeChange`,1),d=n([r(`wa-callout`)],d);export{d as default};