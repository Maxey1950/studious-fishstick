/** A stock Blockly toolbox. MakeCode-specific categories are out of scope for
 * the editor itself — it can render and round-trip MakeCode blocks, but it does
 * not ship MakeCode's block library. */
export const TOOLBOX_XML = `
<xml id="toolbox" style="display: none">
  <category name="Logic" colour="#5C81A6">
    <block type="controls_if"></block>
    <block type="logic_compare"></block>
    <block type="logic_operation"></block>
    <block type="logic_negate"></block>
    <block type="logic_boolean"></block>
  </category>
  <category name="Loops" colour="#5CA65C">
    <block type="controls_repeat_ext">
      <value name="TIMES"><shadow type="math_number"><field name="NUM">10</field></shadow></value>
    </block>
    <block type="controls_whileUntil"></block>
    <block type="controls_forEach"></block>
  </category>
  <category name="Math" colour="#5C68A6">
    <block type="math_number"><field name="NUM">0</field></block>
    <block type="math_arithmetic"></block>
    <block type="math_single"></block>
    <block type="math_random_int">
      <value name="FROM"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
      <value name="TO"><shadow type="math_number"><field name="NUM">100</field></shadow></value>
    </block>
  </category>
  <category name="Text" colour="#5CA68D">
    <block type="text"></block>
    <block type="text_join"></block>
    <block type="text_length"></block>
    <block type="text_print"></block>
  </category>
  <category name="Lists" colour="#745CA6">
    <block type="lists_create_with"></block>
    <block type="lists_length"></block>
    <block type="lists_getIndex"></block>
    <block type="lists_setIndex"></block>
  </category>
  <sep></sep>
  <category name="Variables" colour="#A65C81" custom="VARIABLE"></category>
  <category name="Functions" colour="#9A5CA6" custom="PROCEDURE"></category>
</xml>`;
