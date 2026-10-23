return {
	{
		"neovim/nvim-lspconfig",
		opts = {
			servers = {
				vtsls = {
					enabled = false,
				},
				tsc = {
					enabled = true,
				},
			},
		},
	},
}
