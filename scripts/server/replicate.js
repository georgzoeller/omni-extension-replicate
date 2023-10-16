/**
 * Copyright (c) 2023 MERCENARIES.AI PTE. LTD.
 * All rights reserved.
 */

const script = {
  name: 'blockManager',

  exec: async function (ctx, payload) {
    const sessionId = ctx.sessionId;
    if (payload.length < 1) {
      await ctx.app.sendErrorToSession(
        sessionId,
        `Usage:  \n\` /replicate owner/model\`,  \nfor example:  \n\` /replicate replicate/vicuna-13b\`.`
      );
      return { success: false };
    }
    const [model_owner, model_name] = payload[0].split('/');

    if (!model_name || !model_owner) {
      await ctx.app.sendErrorToSession(
        sessionId,
        `Usage:  \n\` /replicate owner/model\`,  \nfor example:  \n\` /replicate replicate/vicuna-13b\`.`
      );
      return { success: false };
    }

    const result = await ctx.app.blocks.runBlock(ctx, 'replicate.models_get', {
      model_owner,
      model_name,
    });
    const replicateModel = result._omni_result;

    let source = {
      links: {},
    };

    if (replicateModel.github_url)
      source.links.Code = replicateModel.github_url;
    if (replicateModel.paper_url) source.links.Paper = replicateModel.paper_url;
    if (replicateModel.license_url)
      source.links.License = replicateModel.license_url;

    const latest_version = replicateModel.latest_version;
    const raw_schema = latest_version.openapi_schema;

    const nsData = ctx.app.blocks.namespaces.get('replicate');
    const adapter = new ctx.app.blocks.ReteAdapter(
      'omni_extension_replicate:replicate',
      raw_schema,
      nsData
    );
    let schema = raw_schema;
    const components = schema.components;

    function appendDescription(inputs, replicateModel) {
      // Check for required keys in inputs.properties
      const requiredKeys = ['width', 'height', 'Seed', 'prompt'];
      const hasRequiredKeys = requiredKeys.every(key =>
        Object.keys(inputs.properties).some(prop => prop.toLowerCase() === key.toLowerCase())
      );
      
      if (!hasRequiredKeys) return replicateModel.description;
      
      // Check for "xl" in replicateModel.name or replicateModel.description
      const hasXL = replicateModel.name.toLowerCase().includes('xl') || replicateModel.description.toLowerCase().includes('xl');

      if (!hasXL) return replicateModel.description;
      
      // Additional message to append
      const additionalMessage = 
      `
        ***Tips:***

        *For optimal performance on the SDXL model, ensure to use **1024x1024** or others with the same pixel count but varying aspect ratios:*
        
        - **1024 x 1024** (1:1)
        - **1152 x 896** (9:7), **896 x 1152** (7:9)
        - **1216 x 832** (19:13), **832 x 1216** (13:19)
        - **1344 x 768** (7:4), **768 x 1344** (4:7)
        - **1536 x 640** (12:5), **640 x 1536** (5:12)
      `;
      
      return `${replicateModel.description}\n${additionalMessage}`;
    }

    const modifiedDescription = appendDescription(components.schemas.Input, replicateModel);

    const component = ctx.app.blocks.BaseComponent.create(
      'omni-extension-replicate:run', replicateModel.owner + '/' + replicateModel.name, '_' + latest_version.id
    )
      .fromScratch()
      .set('description', modifiedDescription)
      .set('title', `Replicate: ${replicateModel.owner}/${replicateModel.name}`)
      //.set('category', 'Security')
      .setMeta({
        source,
      })
      .setMethod('X-CUSTOM');

    const inputs = components.schemas.Input;
    const output = adapter.resolveSchema(components.schemas.Output);
    component.setCustom('replicate', {
      owner: replicateModel.owner,
      model: replicateModel.name,
      version: latest_version.id,
    });

    for (let key in inputs.properties) {
      let rawSchema = inputs.properties[key];

      // Recursively resolve any $ref in the schema
      let input = Object.assign(
        {},
        rawSchema,
        adapter.resolveSchema(inputs.properties[key])
      );

      // Suboptimal handling of allOf by taking the first element. This can be improved later
      if (input.allOf && input.allOf.length > 0) {
        input.type = input.allOf[0].type;
        if (input.allOf[0].enum) {
          input.type ??= typeof(input.allOf[0].enum[0])
          input.choices = input.allOf[0].enum.map((e) => {
            return { value: e.toString(), title: e.toString() };
          });
        }
        input.title = input.allOf[0].title;
      }
      else if (input.anyOf && input.anyOf.length > 0) {
        input.type = input.anyOf[0].type;
        if (input.anyOf[0].enum) {
          input.type ??= typeof(input.anyOf[0].enum[0])
          input.choices = input.anyOf[0].enum.map((e) => {
            return { value: e.toString(), title: e.toString() };
          });
        }
        input.title = input.anyOf[0].title;
      }

      // enums are represented as choices
      if (input.enum) {
        input.choices = input.enum;
      }

      let customSocket = undefined;
      let customSocketOptions = {};

      // If we have a choices option, which results in a select control, we should provide steps




      if (input.type ==='string')
      {
        input.customSocket = 'text';
      }

      if (input.format === 'uri') {
        customSocketOptions.format = 'base64-withHeader';
        if (
          input.description?.includes('image') ||
          key === 'image' ||
          input.title === 'Image' ||
          key === 'mask' ||
          input.title === "Mask"
        ) {
          customSocket = 'image';
        } else {
          input.type = 'object';
          customSocket = 'file';
        }
      }

      if (input.minimum != null || input.maximum != null) {
      if (input.type === 'number' || input.type === 'float') {
        input.step = 0.01;
        } else if (input.type === 'integer') {
          input.step = 1;
        }
      }

      let defaultV = (replicateModel.default_example?.input?.[key] || input.default) ?? input.default;

      const ip = component
        .createInput(key, input.type, customSocket, customSocketOptions)
        .set('description', input.description);

      // Do not set default value when it is not a required image 
      if (!(customSocket === 'image' && !inputs.required?.includes?.(key))) {
        ip.setDefault(defaultV);
      }

      ip.setConstraints(input.minimum,input.maximum, input.step)
        .set('title', input.title)
        .setRequired(inputs.required?.includes?.(key));

      if (input.choices?.length) {
        ip.setChoices(input.choices, defaultV)
      }

      component.addInput( ip.toOmniIO()

      );

      const enabledInput = component
      .createInput("enabled", "boolean")
      .set('title', "Enabled")
      .set('description', "Programmatically toggle this component")
      .setDefault(true)
      component.addInput( enabledInput.toOmniIO())
    }

    let customSocketOptions = {
      customSettings: {},
    };

    if (output.type == 'array') {
      output.type = output.items.type;
      output.format = output.items.format;
      customSocketOptions.array = true;

      if (output.items.type === 'string') {
        output.type = 'string';
        output.customSocket = 'text';
      } else  if (output.items.anyOf)
      {
        output.type = output.items.anyOf[0].type;
      }
      else
      {
        output.type = output.items?.type
      }

      if (output['x-cog-array-display'] === 'concatenate') {
        customSocketOptions.array = false;
        customSocketOptions.customSettings.array_separator = '';
        customSocketOptions.customSettings.filter_empty = true;
      }
    }

    if (output.format === 'uri') {
      customSocketOptions.array = true;
      if (output.description?.includes('image') || output.title === 'Image' || output.title === 'Mask') {
        output.type = 'array';
        output.customSocket = 'image';
      } else {
        output.type = 'array';
        //output.title = 'File';
        output.customSocket = 'file';
      }
    }

    if (!output.type)
    {
      output.type = 'object'
      console.warn("Unknown output type", output)

    }
    else
    {
      console.warn(output.type)
    }

    component.addOutput(
      component
        .createOutput(
          'output',
          output.type,
          output.customSocket,
          customSocketOptions
        )
        .set('description', output.description)
        .set('title', output.title)
        .toOmniIO()
    );

    component.setMacro('exec', "omni-extension-replicate:replicate_exec")

    const b = component.toJSON()
    ctx.app.blocks.addBlock(component.toJSON());

    console.warn(JSON.stringify(replicateModel, null, 2));

    await ctx.app.sendMessageToSession(
      ctx.sessionId,
      'Created a block for this model.'
      + (b.description ? `\n<br>Description: ${b.description}` : ''),
      'text/markdown',
      {
        commands: [
          {
            id: 'add',
            args: [b.displayNamespace + '.' + b.displayOperationId],
            title: `Add ${b.title}`,
          },
        ],
      }
    );
    return {
      replicateResult: result,
      block: b
    }
  },
};
export default script;
